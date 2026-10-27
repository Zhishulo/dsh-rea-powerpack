// dsh-rea-powerpack — host half.
//
// Owns the /rea-powerpack management API the browser half talks to, the pin
// bookkeeping, the engine matrix and the MCP row reload. Every route is
// loopback-only, every mutating route is serialised, and every failure is
// reported with one of a small stable set of error codes so the UI can map it
// to a localised message.

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { byId, CATALOG_VERSION } from './catalog.js'
import {
  appendLog,
  catalogSnapshot,
  coded,
  defaultExec,
  detect,
  engineStatus,
  isWritable,
  powerpackHome,
  readManifest,
  readSettings,
  readState,
  writeSettings,
  writeState,
  verifyAll,
  installEngine,
  uninstallEngine,
  importEngine,
} from './engines.js'
import {
  INSTALL_TIMEOUT_MS,
  compareVersions,
  decideUpgrade,
  installedVersion,
  lookupLatest,
  readPin,
  rollback,
  upgradeRea,
  writePin,
} from './pin.js'
import { profileDir, reloadMcpRow } from './reload.js'

/** Plugin name, used for the Loader row label and the effect label. */
export const name = 'dsh-rea-powerpack'
/** This plugin only contributes an HTTP surface. */
export const inject = ['webServer']

const PREFIX = '/rea-powerpack'
/**
 * Loader row id of our MCP client row. Must match the `id:` written in
 * cordis.patch.yml (`rea-powerpack-mcp`) — the host looks rows up by id, so a
 * mismatched constant silently reports "row missing" and can never reload it.
 */
const SELF = 'dsh-rea-powerpack'
const ROW_ID = 'rea-powerpack-mcp'
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const BODY_LIMIT = 64 * 1024
const AUTO_IDLE_MS = 10 * 60 * 1000
const DOCTOR_TIMEOUT_MS = 240 * 1000

const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), 'rea-mcp.mjs')

// ------------------------------------------------------------------ helpers --

function isLoopback(request) {
  const address = request && request.socket ? request.socket.remoteAddress : null
  if (!address) return false
  if (LOOPBACK.has(address)) return true
  // Some stacks report an IPv4-mapped address with a port suffix or zone id.
  return LOOPBACK.has(String(address).replace(/%.+$/, ''))
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function sendMarkdown(response, status, text) {
  response.writeHead(status, {
    'content-type': 'text/markdown; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

function statusFor(code) {
  if (code === 'loopback_only') return 403
  if (code === 'not_found') return 404
  if (code === 'busy') return 409
  if (
    code === 'bad_request' ||
    code === 'bad_json' ||
    code === 'pin_conflict' ||
    code === 'no_engine' ||
    code === 'unknown_engine' ||
    code === 'no_such_version' ||
    code === 'requires_dependency' ||
    code === 'unsupported_host'
  ) {
    return 400
  }
  if (code === 'checksum_mismatch') return 422
  if (
    code === 'install_failed' ||
    code === 'download_failed' ||
    code === 'registry_timeout' ||
    code === 'registry_unreachable' ||
    code === 'preflight_failed' ||
    code === 'rollback_failed' ||
    code === 'reload_failed' ||
    code === 'verify_failed' ||
    code === 'rea_missing' ||
    code === 'profile_unwritable'
  ) {
    return 502
  }
  return 500
}

function failure(code, message, extra) {
  const detail = typeof message === 'string' && message !== '' ? message : code
  return { ok: false, error: { code: code, message: detail, detail: detail, ...(extra || {}) } }
}

function failureStatus(error) {
  const code = error && typeof error.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'internal'
  return statusFor(code)
}

function sendFailure(response, error) {
  sendJson(response, failureStatus(error), failure(codeOf(error), messageOf(error)))
}

function codeOf(error) {
  if (error && typeof error.code === 'string' && /^[a-z_]+$/.test(error.code)) return error.code
  if (error && error.name === 'SyntaxError') return 'bad_json'
  return 'internal'
}

function messageOf(error) {
  if (typeof error === 'string') return error
  if (error && typeof error.message === 'string' && error.message !== '') return error.message
  return 'Unexpected failure.'
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > BODY_LIMIT) throw coded('bad_request', 'Request body is larger than ' + BODY_LIMIT + ' bytes.')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : {}
  } catch {
    throw coded('bad_json', 'Request body is not valid JSON.')
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// -------------------------------------------------------------- host state --

/**
 * Loader rows, tolerating a host that does not expose the loader service.
 *
 * `ctx.loader.entries()` is a generator, not an array (cordis-plugin-loader
 * EntryTree), so it has to be materialised before filtering. Treating the
 * iterator as an array silently reported "row missing" for every install.
 */
function loaderRows(ctx) {
  try {
    if (!ctx || !ctx.loader || typeof ctx.loader.entries !== 'function') return []
    const entries = ctx.loader.entries()
    if (Array.isArray(entries)) return entries
    if (entries && typeof entries[Symbol.iterator] === 'function') return Array.from(entries)
    return []
  } catch {
    return []
  }
}

function rowView(entry) {
  const options = entry && isObject(entry.options) ? entry.options : {}
  const config = isObject(options.config) ? options.config : {}
  let id = null
  let disabled = false
  let present = false
  try {
    id = typeof entry.id === 'string' ? entry.id : null
  } catch {
    id = null
  }
  try {
    disabled = entry.disabled === true
  } catch {
    disabled = false
  }
  try {
    present = Boolean(entry.fiber)
  } catch {
    present = false
  }
  return {
    id: id,
    name: typeof options.name === 'string' ? options.name : null,
    serverName: typeof config.serverName === 'string' ? config.serverName : null,
    disabled: disabled,
    present: present,
  }
}

/** Entry ids are prefixed with the owning entry id ('parent:child'), so match the tail. */
function sameRowId(id, wanted) {
  return id === wanted || (typeof id === 'string' && id.endsWith(':' + wanted))
}

function findMcpRow(rows) {
  for (const entry of rows) {
    const row = rowView(entry)
    if (sameRowId(row.id, ROW_ID)) return row
  }
  for (const entry of rows) {
    const row = rowView(entry)
    if (row.name === MCP_CLIENT && row.serverName === 'rea') return row
  }
  return null
}

/** A second MCP server registered under the same name makes REA's tools ambiguous. */
function findConflict(rows) {
  for (const entry of rows) {
    const row = rowView(entry)
    if (row.name === 'dsh-rea-agents' || sameRowId(row.id, 'rea-agents-mcp')) {
      return { kind: 'server_name_conflict', detail: 'dsh-rea-agents' }
    }
  }
  return null
}

/** Patch file the host loads (cordis.patch.yml in the profile root). */
function patchPathFor(profile) {
  return join(profile, 'cordis.patch.yml')
}

async function patchInfo(profile) {
  const path = patchPathFor(profile)
  try {
    const info = await stat(path)
    return { path, present: true, size: info.size, mtime: info.mtime.toISOString() }
  } catch {
    return { path, present: false, size: null, mtime: null }
  }
}

/** Recent JSONL operations, newest first. */
async function tailLogs(home, limit) {
  try {
    const text = await readFile(join(home, 'logs', 'powerpack.log'), 'utf8')
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const rows = []
    for (const line of lines.slice(-limit)) {
      try {
        const value = JSON.parse(line)
        rows.push({
          at: typeof value.at === 'string' ? value.at : null,
          level: typeof value.level === 'string' ? value.level : 'info',
          event: typeof value.event === 'string' ? value.event : null,
          detail: value.detail === undefined ? null : value.detail,
        })
      } catch {
        /* a truncated tail line is not an error */
      }
    }
    return rows.reverse()
  } catch {
    return []
  }
}

let cachedSelf = null

async function selfInfo() {
  if (cachedSelf) return cachedSelf
  cachedSelf = { name: SELF, version: '0.0.0' }
  try {
    const manifest = JSON.parse(await readFile(join(dirname(LAUNCHER), '..', 'package.json'), 'utf8'))
    if (typeof manifest.version === 'string') cachedSelf.version = manifest.version
  } catch {
    /* the version is cosmetic */
  }
  return cachedSelf
}

/** Cached /doctor result plus whether it is older than the engine manifest. */
function doctorSummary(state, manifest) {
  const last = state && isObject(state.lastDoctor) ? state.lastDoctor : null
  if (!last) return { stale: true, lastAt: null, toolCount: null, availableGroups: null, totalGroups: null }
  const lastAt = typeof last.at === 'string' ? last.at : null
  const manifestAt = typeof manifest.updatedAt === 'string' ? manifest.updatedAt : null
  const stale = !lastAt || (manifestAt !== null && manifestAt > lastAt)
  return {
    stale,
    lastAt,
    toolCount: Number.isFinite(last.toolCount) ? last.toolCount : null,
    availableGroups: Number.isFinite(last.availableGroups) ? last.availableGroups : null,
    totalGroups: Number.isFinite(last.totalGroups) ? last.totalGroups : null,
  }
}

/** Human summary of engines REA expects on this host but that are not ready. */
function enginesWarning(statuses) {
  const missing = statuses.filter((entry) => entry.status !== 'ok' && entry.status !== 'external_ok' && entry.spec.tier <= 1)
  if (missing.length === 0) return null
  const names = missing.map((entry) => entry.spec.name).join(', ')
  return missing.length === 1
    ? names + ' is not available; REA tools that need it stay disabled.'
    : names + ' are not available; the matching REA tool groups stay disabled.'
}

/**
 * Everything /state reports. Deliberately read-only: it never executes a
 * third-party binary and never writes the manifest.
 */
async function describeState(ctx, profile) {
  const home = powerpackHome(profile)
  const settings = await readSettings(home)
  const manifest = await readManifest(home)
  const detection = await detect(home, settings, process.platform, manifest)
  const pin = await readPin(home)
  const installed = await installedVersion(profile)
  const cached = await readState(home)
  const rows = loaderRows(ctx)
  const row = findMcpRow(rows)
  const writable = await isWritable(home)
  const engines = detection.statuses.map((entry) => engineStatus(entry))
  return {
    self: await selfInfo(),
    profileDir: profile,
    writable,
    rea: {
      installed: Boolean(installed),
      pinned: pin.requested || pin.version || null,
      requested: pin.requested,
      pinnedAt: pin.pinnedAt,
      pinnedFrom: pin.pinnedFrom,
      source: pin.pinnedFrom,
      latestKnown: pin.latestKnown,
      checkedAt: pin.checkedAt,
      retained: pin.retained,
      enginesWarning: enginesWarning(detection.statuses),
    },
    engines,
    settings: {
      updatePolicy: settings.updatePolicy,
      engineRoot: settings.engineRoot === null ? detection.root : settings.engineRoot,
    },
    mcp: { rowId: row ? row.id : null, present: Boolean(row), disabled: Boolean(row && row.disabled) },
    conflict: findConflict(rows),
    doctor: doctorSummary(cached, manifest),
    host: {
      platform: process.platform,
      node: process.versions ? process.versions.node : null,
      javaHome: process.env.JAVA_HOME || null,
      ghidraDir: process.env.GHIDRA_INSTALL_DIR || null,
    },
    catalogVersion: CATALOG_VERSION,
    patch: await patchInfo(profile),
    lastOps: await tailLogs(home, 20),
  }
}

// ------------------------------------------------------- handshake / doctor --

function killQuietly(child) {
  try {
    child.kill('SIGKILL')
  } catch {
    /* already gone */
  }
}

/**
 * One real MCP stdio handshake against the launcher this plugin ships.
 * Returns REA's own tool-availability report: the only trustworthy answer to
 * "did the engines actually get wired up".
 */
async function handshakeReport(profile, home) {
  const node = process.env.REA_POWERPACK_NODE || process.execPath
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  const child = spawn(node, [LAUNCHER, profile, 'mcp'], {
    cwd: profile,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  let buffer = ''
  let nextId = 1
  let settled = false
  const pending = new Map()

  const finish = (error, value) => {
    if (settled) return
    settled = true
    clearTimeout(overall)
    for (const item of pending.values()) item.reject(new Error('handshake finished'))
    pending.clear()
    try {
      child.stdin.end()
    } catch {
      /* ignore */
    }
    killQuietly(child)
    if (error) rejectOuter(error)
    else resolveOuter(value)
  }

  const request = (method, params, timeoutMs) =>
    new Promise((resolve, reject) => {
      const id = nextId
      nextId += 1
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('timed out waiting for ' + method + ' after ' + Math.round(timeoutMs / 1000) + 's'))
      }, timeoutMs)
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      if (!child.stdin.writable) {
        clearTimeout(timer)
        pending.delete(id)
        reject(new Error('the launcher closed its stdin before ' + method))
        return
      }
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params }) + '\n')
    })

  const notify = (method, params) => {
    try {
      if (child.stdin.writable) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: method, params: params }) + '\n')
    } catch {
      /* a dead child is reported by the exit handler */
    }
  }

  let resolveOuter = () => {}
  let rejectOuter = () => {}
  const done = new Promise((resolve, reject) => {
    resolveOuter = resolve
    rejectOuter = reject
  })
  let overall = setTimeout(() => finish(coded('verify_failed', 'REA handshake timed out after ' + Math.round(DOCTOR_TIMEOUT_MS / 1000) + 's.')), DOCTOR_TIMEOUT_MS)
  if (typeof overall.unref === 'function') overall.unref()

  child.once('error', (error) => finish(coded('verify_failed', 'Could not start the launcher: ' + error.message)))
  child.once('exit', (code, signal) => {
    const tail = stderr.trim().split('\n').slice(-4).join(' | ')
    finish(coded('verify_failed', 'The launcher exited before the handshake completed (code ' + code + (signal ? ', ' + signal : '') + ')' + (tail ? ': ' + tail : '')))
  })
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
    if (stderr.length > 16384) stderr = stderr.slice(-16384)
  })
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk)
    if (buffer.length > 64 * 1024 * 1024) {
      finish(coded('verify_failed', 'The launcher produced an oversized handshake response.'))
      return
    }
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (!message || typeof message !== 'object' || message.id === undefined) continue
      const item = pending.get(message.id)
      if (!item) continue
      pending.delete(message.id)
      if (message.error) item.reject(new Error(JSON.stringify(message.error)))
      else item.resolve(message.result)
    }
  })

  const run = async () => {
    const init = await request(
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: SELF, version: (await selfInfo()).version } },
      60000,
    )
    notify('notifications/initialized', {})
    const serverInfo = (init && init.serverInfo) || {}
    const tools = []
    let cursor
    do {
      const page = await request('tools/list', cursor ? { cursor: cursor } : {}, 120000)
      for (const tool of Array.isArray(page && page.tools) ? page.tools : []) {
        if (tool && typeof tool.name === 'string') tools.push(tool)
      }
      cursor = page ? page.nextCursor : null
    } while (cursor)

    const report = {
      at: new Date().toISOString(),
      serverVersion: typeof serverInfo.version === 'string' ? serverInfo.version : null,
      serverName: typeof serverInfo.name === 'string' ? serverInfo.name : null,
      toolCount: tools.length,
      availableGroups: null,
      totalGroups: null,
      byReason: {},
      gaps: [],
    }
    if (tools.some((tool) => tool.name === 'binary_session')) {
      try {
        const response = await request('tools/call', { name: 'binary_session', arguments: {} }, 180000)
        const text = (Array.isArray(response && response.content) ? response.content : [])
          .filter((item) => item && item.type === 'text')
          .map((item) => item.text)
          .join('\n')
        let parsed = null
        try {
          parsed = JSON.parse(text)
        } catch {
          /* an empty session report is not fatal */
        }
        const availability = (parsed && parsed.result && parsed.result.tool_availability) || (parsed && parsed.tool_availability) || {}
        const groups = Array.isArray(availability.groups) ? availability.groups : []
        const down = groups.filter((group) => group && group.available === false)
        report.totalGroups = groups.length
        report.availableGroups = groups.length - down.length
        for (const group of down) {
          const reason = typeof group.reason === 'string' && group.reason !== '' ? group.reason : 'unknown'
          report.byReason[reason] = (report.byReason[reason] || 0) + 1
        }
        const ignored = new Set(['jeb-provider'])
        const real = down.filter(
          (group) => (group.reason === 'provider_unavailable' || group.reason === 'provider_missing') && !ignored.has(group.surface),
        )
        report.gaps = real.map((group) => ({
          reason: group.reason,
          remedy: String(group.remediation || '').slice(0, 400) || null,
          count: Array.isArray(group.names) ? group.names.length : 0,
          tools: Array.isArray(group.names) ? group.names.slice(0, 24) : [],
          surface: group.surface || null,
        }))
      } catch (error) {
        report.binarySessionError = messageOf(error)
      }
    }
    if (report.toolCount < 200) {
      throw coded(
        'verify_failed',
        'REA advertised only ' + report.toolCount + ' tools, which is below the healthy minimum of 200. ' + (stderr.trim() ? 'stderr: ' + stderr.trim().split('\n').slice(-3).join(' | ') : ''),
      )
    }
    report.stderr = stderr.length > 0 ? stderr.slice(-2000) : null
    finish(null, report)
    return report
  }

  run().catch((error) => finish(codeOf(error) === 'internal' ? coded('verify_failed', messageOf(error)) : error))
  return done
}

/** Probe, then cache the result in state.json so /state can show it cheaply. */
async function runDoctor(profile, home) {
  const report = await handshakeReport(profile, home)
  const summary = {
    at: report.at,
    serverVersion: report.serverVersion,
    toolCount: report.toolCount,
    availableGroups: report.availableGroups,
    totalGroups: report.totalGroups,
    byReason: report.byReason,
  }
  await writeState(home, { lastDoctor: { ...summary, topGaps: report.gaps.slice(0, 8), serverName: report.serverName } })
  await appendLog(home, 'info', 'doctor', {
    toolCount: report.toolCount,
    availableGroups: report.availableGroups,
    totalGroups: report.totalGroups,
    gaps: report.gaps.length,
  })
  return { summary, report }
}

// ------------------------------------------------------------------ report --

function cell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** Markdown diagnostic dump: everything a user should paste into an issue. */
async function buildReport(ctx, profile) {
  const home = powerpackHome(profile)
  const state = await describeState(ctx, profile)
  const cached = await readState(home)
  const manifest = await readManifest(home)
  const logs = await tailLogs(home, 20)
  const last = cached && isObject(cached.lastDoctor) ? cached.lastDoctor : null
  const fence = '\u0060\u0060\u0060'
  const lines = []
  lines.push('# REA Powerpack report')
  lines.push('')
  lines.push('- generated: ' + new Date().toISOString())
  lines.push('- plugin: ' + state.self.name + ' ' + state.self.version)
  lines.push('- catalog: v' + state.catalogVersion + ' (' + catalogSnapshot().length + ' engines)')
  lines.push('- profile: ' + profile)
  lines.push('- state dir: ' + home + (state.writable ? '' : ' (NOT WRITABLE)'))
  lines.push('')
  lines.push('## REA server')
  lines.push('')
  lines.push('- installed: ' + (state.rea.installed ? 'yes' : 'no'))
  lines.push('- pinned: ' + (state.rea.pinned || '(none)'))
  lines.push('- requested: ' + (state.rea.requested || '(none)'))
  lines.push('- pinned at / from: ' + (state.rea.pinnedAt || '-') + ' / ' + (state.rea.pinnedFrom || '-'))
  lines.push('- retained: ' + (state.rea.retained && state.rea.retained.from ? state.rea.retained.from : '(none)'))
  lines.push('- latest known: ' + (state.rea.latestKnown || '(unknown)') + (state.rea.checkedAt ? ' (checked ' + state.rea.checkedAt + ')' : ''))
  if (state.rea.enginesWarning) lines.push('- engines warning: ' + state.rea.enginesWarning)
  lines.push('')
  lines.push('## Engines')
  lines.push('')
  lines.push('| id | tier | status | version | env | path |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const engine of state.engines) {
    lines.push(
      '| ' +
        cell(engine.id) +
        ' | ' +
        cell(engine.tier) +
        ' | ' +
        cell(engine.status) +
        ' | ' +
        cell(engine.version || '-') +
        ' | ' +
        cell(engine.envVar || '-') +
        ' | ' +
        cell(engine.path || '-') +
        ' |',
    )
  }
  lines.push('')
  const ready = state.engines.filter((engine) => engine.status === 'ok' || engine.status === 'external_ok').length
  lines.push('Ready: ' + ready + ' / ' + state.engines.length)
  const unsupported = state.engines.filter((engine) => engine.status === 'unsupported_host')
  if (unsupported.length > 0) lines.push('Unsupported on this host: ' + unsupported.map((engine) => engine.id).join(', '))
  lines.push('')
  lines.push('## Doctor')
  lines.push('')
  if (!last) {
    lines.push('No handshake has been recorded yet (run the doctor probe).')
  } else {
    lines.push('- at: ' + (last.at || '-'))
    lines.push('- server version: ' + (last.serverVersion || '-'))
    lines.push('- tools: ' + (last.toolCount === undefined || last.toolCount === null ? '-' : last.toolCount))
    lines.push('- groups available: ' + (last.availableGroups === null || last.availableGroups === undefined ? '-' : last.availableGroups) + ' / ' + (last.totalGroups === null || last.totalGroups === undefined ? '-' : last.totalGroups))
    const byReason = isObject(last.byReason) ? last.byReason : {}
    const reasons = Object.keys(byReason)
    if (reasons.length > 0) lines.push('- unavailable by reason: ' + reasons.map((reason) => reason + '=' + byReason[reason]).join(', '))
    const gaps = Array.isArray(last.topGaps) ? last.topGaps : []
    if (gaps.length > 0) {
      lines.push('')
      lines.push('### Capability gaps')
      lines.push('')
      for (const gap of gaps) {
        lines.push('- **' + cell(gap.surface || gap.reason) + '** [' + cell(gap.reason) + '] ' + gap.count + ' tool(s)')
        if (gap.remedy) lines.push('  - remedy: ' + String(gap.remedy).replace(/\r?\n/g, ' '))
      }
    }
  }
  lines.push('')
  lines.push('## Patch and MCP row')
  lines.push('')
  lines.push('- patch: ' + (state.patch.present ? state.patch.path + ' (' + state.patch.size + ' bytes, mtime ' + state.patch.mtime + ')' : '(not found: ' + state.patch.path + ')'))
  lines.push('- mcp row: ' + (state.mcp.present ? state.mcp.rowId + (state.mcp.disabled ? ' (disabled)' : '') : '(absent - reload the host)'))
  lines.push('- conflicting row: ' + (state.conflict ? state.conflict.kind + ' (' + state.conflict.detail + ')' : 'none'))
  lines.push('- last reload: ' + (cached.lastReload ? JSON.stringify(cached.lastReload) : '(never)'))
  lines.push('')
  lines.push('## Settings')
  lines.push('')
  lines.push(fence + 'json')
  lines.push(JSON.stringify(state.settings, null, 2))
  lines.push(fence)
  lines.push('')
  lines.push('## Host')
  lines.push('')
  lines.push('- platform: ' + state.host.platform + ' (node ' + state.host.node + ')')
  lines.push('- JAVA_HOME: ' + (state.host.javaHome || '(unset)'))
  lines.push('- GHIDRA_INSTALL_DIR: ' + (state.host.ghidraDir || '(unset)'))
  lines.push('- REA_POWERPACK_HOME: ' + (process.env.REA_POWERPACK_HOME || '(default)'))
  lines.push('')
  lines.push('## Environment variables REA reads')
  lines.push('')
  const seen = new Set()
  for (const engine of state.engines) {
    if (!engine.envVar || seen.has(engine.envVar)) continue
    seen.add(engine.envVar)
    lines.push('- ' + engine.envVar + ' -> ' + engine.id + ' (' + engine.status + ')')
  }
  lines.push('- JAVA_HOME (external), GHIDRA_INSTALL_DIR (external)')
  lines.push('')
  lines.push('## Recent operations')
  lines.push('')
  if (logs.length === 0) {
    lines.push('(no log entries yet)')
  } else {
    for (const row of logs) {
      lines.push('- ' + (row.at || '-') + ' [' + row.level + '] ' + (row.event || '-') + (row.detail === null ? '' : ' ' + JSON.stringify(row.detail)))
    }
  }
  lines.push('')
  lines.push('## Manifest')
  lines.push('')
  lines.push(fence + 'json')
  lines.push(JSON.stringify({ version: manifest.version, root: manifest.root, updatedAt: manifest.updatedAt, engines: manifest.engines.map((record) => ({ id: record.id, version: record.version, path: record.path, verified: record.verified, source: record.source })) }, null, 2))
  lines.push(fence)
  lines.push('')
  return lines.join('\n')
}

// -------------------------------------------------------------- operations --

function loggerFor(home) {
  return async (level, event, detail) => {
    await appendLog(home, level, event, detail)
  }
}

async function refreshEngine(home, settings, id) {
  const manifest = await readManifest(home)
  const detection = await detect(home, settings, process.platform, manifest)
  const entry = detection.byId.get(id)
  return entry ? engineStatus(entry) : null
}

async function opCheck(home, profile) {
  const settings = await readSettings(home)
  const pin = await readPin(home)
  const installed = await installedVersion(profile)
  const latest = await lookupLatest(profile, defaultExec, { timeout: 60000 })
  const now = new Date().toISOString()
  const next = await writePin(home, { ...pin, latestKnown: latest.version, checkedAt: now })
  const decision = decideUpgrade({
    pinned: installed || pin.requested || pin.version,
    latest: latest.version,
    policy: settings.updatePolicy,
    runningTurns: 0,
  })
  await appendLog(home, 'info', 'rea.check', { latest: latest.version, installed: installed, decision: decision })
  return { ok: true, latest: latest.version, checkedAt: now, installed: installed, decision: decision, pin: next }
}

/**
 * Upgrade REA, then hot-reload the MCP row so the new build is what the host
 * actually talks to. The preflight/rollback dance lives in pin.js.
 */
async function opUpdate(ctx, home, profile, body) {
  const settings = await readSettings(home)
  const pin = await readPin(home)
  const installed = await installedVersion(profile)
  let target = body && typeof body.version === 'string' && body.version.trim() !== '' ? body.version.trim() : null
  if (target && pin.withheldBuilds.includes(target)) {
    throw coded('pin_conflict', 'Build ' + target + ' was withheld after a failed handshake. Pick another version.')
  }
  if (!target) {
    const latest = await lookupLatest(profile, defaultExec, { timeout: 60000 })
    await writePin(home, { ...pin, latestKnown: latest.version, checkedAt: new Date().toISOString() })
    target = latest.version
  }
  if (installed && target === installed) {
    await appendLog(home, 'info', 'rea.update.noop', { version: installed })
    return { ok: true, from: installed, to: installed, upToDate: true, preflight: null, reload: null }
  }
  const log = loggerFor(home)
  const result = await upgradeRea(home, profile, target, { exec: defaultExec, log: log })
  const reload = await reloadRow(ctx, home)
  return {
    ok: true,
    from: result.from,
    to: result.to,
    upToDate: false,
    preflight: result.preflight,
    handshake: result.handshake || null,
    reload: reload,
  }
}

async function opPin(home, profile, body) {
  const version = body && typeof body.version === 'string' ? body.version.trim() : ''
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw coded('bad_request', 'pin requires a version such as 6.8.0 (received: ' + String(version) + ').')
  }
  const pin = await readPin(home)
  if (pin.withheldBuilds.includes(version)) {
    throw coded('pin_conflict', 'Build ' + version + ' was withheld after a failed handshake.')
  }
  const installed = await installedVersion(profile)
  const now = new Date().toISOString()
  const next = await writePin(home, {
    ...pin,
    version: version,
    requested: version,
    pinnedAt: now,
    pinnedFrom: 'ui',
  })
  await appendLog(home, 'info', 'rea.pin', { version: version, installed: installed })
  return { ok: true, pin: next, installed: installed, requiresInstall: installed !== version }
}

async function opSettings(home, body) {
  const patch = {}
  if (body && 'updatePolicy' in body) {
    if (!['notify', 'auto-idle', 'manual'].includes(body.updatePolicy)) {
      throw coded('bad_request', 'updatePolicy must be one of notify, auto-idle or manual.')
    }
    patch.updatePolicy = body.updatePolicy
  }
  if (body && 'engineRoot' in body) {
    if (body.engineRoot !== null && typeof body.engineRoot !== 'string') {
      throw coded('bad_request', 'engineRoot must be a directory path or null.')
    }
    patch.engineRoot = body.engineRoot
  }
  if (body && 'toolTimeoutMs' in body) {
    if (!Number.isFinite(body.toolTimeoutMs) || body.toolTimeoutMs < 1000) {
      throw coded('bad_request', 'toolTimeoutMs must be a number of milliseconds, at least 1000.')
    }
    patch.toolTimeoutMs = body.toolTimeoutMs
  }
  if (body && 'checkIntervalHours' in body) {
    if (!Number.isFinite(body.checkIntervalHours) || body.checkIntervalHours <= 0) {
      throw coded('bad_request', 'checkIntervalHours must be a positive number of hours.')
    }
    patch.checkIntervalHours = body.checkIntervalHours
  }
  if (body && 'locale' in body) {
    if (!['auto', 'zh', 'en'].includes(body.locale)) {
      throw coded('bad_request', 'locale must be one of auto, zh or en.')
    }
    patch.locale = body.locale
  }
  if (Object.keys(patch).length === 0) throw coded('bad_request', 'No recognised setting in the request body.')
  const settings = await writeSettings(home, patch)
  await appendLog(home, 'info', 'settings.write', { keys: Object.keys(patch) })
  return { ok: true, settings: settings }
}

async function opInstall(home, body) {
  const id = body && typeof body.id === 'string' ? body.id.trim() : ''
  if (id === '') throw coded('bad_request', 'engine install requires an id')
  if (!byId(id)) throw coded('unknown_engine', 'Unknown engine: ' + id)
  const settings = await readSettings(home)
  const result = await installEngine(home, settings, id, loggerFor(home))
  const engine = await refreshEngine(home, settings, id)
  return { ok: true, engine: engine, root: result.root || null }
}

async function opUninstall(home, body) {
  const id = body && typeof body.id === 'string' ? body.id.trim() : ''
  if (id === '') throw coded('bad_request', 'engine uninstall requires an id')
  if (!byId(id)) throw coded('unknown_engine', 'Unknown engine: ' + id)
  const settings = await readSettings(home)
  const result = await uninstallEngine(home, id, { log: loggerFor(home) })
  const engine = await refreshEngine(home, settings, id)
  await appendLog(home, 'info', 'engine.uninstall', { id: id, removed: result.removed })
  return { ok: true, engine: engine, removed: result.removed }
}

async function opImport(home, body) {
  const path = body && typeof body.path === 'string' ? body.path.trim() : ''
  if (path === '') throw coded('bad_request', 'engine import requires a path')
  const settings = await readSettings(home)
  const result = await importEngine(home, settings, { path: path, id: body.id }, { exec: defaultExec })
  const engine = await refreshEngine(home, settings, body.id || (result.engine && result.engine.id))
  await appendLog(home, 'info', 'engine.import', { path: path, id: result.engine ? result.engine.id : null })
  return { ok: true, engine: engine || result.engine }
}

async function opImportPin(home, body, profile) {
  let raw = null
  if (body && typeof body.pin === 'object' && body.pin !== null) raw = body.pin
  else if (body && typeof body.text === 'string' && body.text.trim() !== '') {
    try {
      raw = JSON.parse(body.text)
    } catch {
      throw coded('bad_json', 'The pasted pin is not valid JSON.')
    }
  } else if (body && typeof body.path === 'string' && body.path.trim() !== '') {
    try {
      raw = JSON.parse(await readFile(body.path.trim(), 'utf8'))
    } catch (error) {
      throw coded('bad_request', 'Could not read ' + body.path.trim() + ': ' + messageOf(error))
    }
  } else {
    const candidate = join(profile, 'dsh-rea-agents', 'pin.json')
    try {
      raw = JSON.parse(await readFile(candidate, 'utf8'))
    } catch {
      throw coded('bad_request', 'Nothing to import: send {text}, {pin} or {path}.')
    }
  }
  if (!isObject(raw)) throw coded('bad_request', 'The imported pin must be a JSON object.')
  const version = typeof raw.version === 'string' ? raw.version : typeof raw.requested === 'string' ? raw.requested : null
  if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw coded('bad_request', 'The imported pin has no usable version field.')
  }
  const next = await writePin(home, {
    version: version,
    requested: typeof raw.requested === 'string' ? raw.requested : version,
    pinnedAt: typeof raw.pinnedAt === 'string' ? raw.pinnedAt : new Date().toISOString(),
    pinnedFrom: 'ui',
    retained: isObject(raw.retained) && typeof raw.retained.from === 'string' ? raw.retained : null,
    withheldBuilds: Array.isArray(raw.withheldBuilds) ? raw.withheldBuilds : [],
    latestKnown: typeof raw.latestKnown === 'string' ? raw.latestKnown : null,
    checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : null,
  })
  await appendLog(home, 'info', 'pin.import', { version: version })
  return { ok: true, pin: next }
}

/** Disable + enable the MCP row and report honestly whether that was enough. */
async function reloadRow(ctx, home) {
  const row = findMcpRow(loaderRows(ctx))
  let result
  if (!row) {
    result = { ok: false, mode: 'restart-required', reason: 'The MCP row is not loaded; restart DeepSeek Harness.', restoredPatch: false }
  } else {
    result = await reloadMcpRow(ctx, row.id)
  }
  const at = new Date().toISOString()
  await writeState(home, {
    lastReload: { at: at, ok: result.ok === true, mode: result.mode, reason: result.reason || null },
  })
  await appendLog(home, result.ok ? 'info' : 'warn', 'mcp.reload', {
    ok: result.ok === true,
    mode: result.mode,
    reason: result.reason || null,
    restoredPatch: result.restoredPatch === true,
  })
  return result
}

// ---------------------------------------------------------------- routing --

function routeOf(request) {
  const url = new URL(request.url || '/', 'http://127.0.0.1')
  let route = url.pathname
  if (route !== PREFIX && !route.startsWith(PREFIX + '/')) return null
  route = route.slice(PREFIX.length) || '/'
  if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1)
  return route
}

/**
 * Build the HTTP handler. All mutating routes share one in-flight slot: REA
 * pins, engine installs and MCP reloads must never interleave, and a second
 * click must get a clear busy error instead of a half-applied state.
 */
function createHandler(ctx, session) {
  const acquire = () => {
    if (session.busy) throw coded('busy', 'Another operation is already running; wait for it to finish.')
    session.busy = true
    return () => {
      session.busy = false
    }
  }

  return async function handler(request, response) {
    try {
      if (!isLoopback(request)) {
        sendJson(response, 403, failure('loopback_only', 'The REA Powerpack API is only reachable from this machine.'))
        return
      }
      session.lastApiAt = Date.now()
      const route = routeOf(request)
      if (route === null) {
        sendJson(response, 404, failure('not_found', 'No route for ' + String(request.url || '')))
        return
      }
      const method = String(request.method || 'GET').toUpperCase()
      const profile = profileDir(ctx)
      const home = powerpackHome(profile)

      if (method === 'GET' && route === '/') {
        sendJson(response, 200, {
          ok: true,
          name: SELF,
          version: (await selfInfo()).version,
          prefix: PREFIX,
        })
        return
      }

      if (method === 'GET' && route === '/state') {
        sendJson(response, 200, await describeState(ctx, profile))
        return
      }

      if (method === 'GET' && route === '/report') {
        sendMarkdown(response, 200, await buildReport(ctx, profile))
        return
      }

      if (method === 'GET' && route === '/doctor') {
        const release = acquire()
        try {
          const result = await runDoctor(profile, home)
          sendJson(response, 200, {
            ...result.summary,
            serverName: result.report.serverName,
            gaps: result.report.gaps,
            byReason: result.report.byReason,
          })
        } finally {
          release()
        }
        return
      }

      if (method === 'POST') {
        const body = await readJsonBody(request)
        const release = acquire()
        try {
          if (route === '/check') {
            sendJson(response, 200, await opCheck(home, profile))
            return
          }
          if (route === '/update') {
            const result = await opUpdate(ctx, home, profile, body)
            session.lastReloadAt = Date.now()
            sendJson(response, 200, result)
            return
          }
          if (route === '/pin') {
            sendJson(response, 200, await opPin(home, profile, body))
            return
          }
          if (route === '/settings') {
            sendJson(response, 200, await opSettings(home, body))
            return
          }
          if (route === '/engines/verify') {
            const settings = await readSettings(home)
            const verification = await verifyAll(home, settings, { exec: defaultExec, log: loggerFor(home) })
            const detection = await detect(home, settings, process.platform, verification.manifest)
            sendJson(response, 200, {
              ok: true,
              root: verification.root,
              results: verification.results,
              engines: detection.statuses.map((entry) => engineStatus(entry)),
            })
            return
          }
          if (route === '/engines/install') {
            sendJson(response, 200, await opInstall(home, body))
            return
          }
          if (route === '/engines/uninstall') {
            sendJson(response, 200, await opUninstall(home, body))
            return
          }
          if (route === '/engines/import') {
            sendJson(response, 200, await opImport(home, body))
            return
          }
          if (route === '/import-pin') {
            sendJson(response, 200, await opImportPin(home, body, profile))
            return
          }
          if (route === '/reload') {
            const result = await reloadRow(ctx, home)
            session.lastReloadAt = Date.now()
            sendJson(response, 200, result)
            return
          }
          sendJson(response, 404, failure('not_found', 'No route for POST ' + route))
        } finally {
          release()
        }
        return
      }

      sendJson(response, 404, failure('not_found', 'No route for ' + method + ' ' + route))
    } catch (error) {
      try {
        sendFailure(response, error)
      } catch {
        /* the socket is already gone */
      }
    }
  }
}

// ------------------------------------------------------------- background --

/**
 * Idle-only update check. It never fights the user: it waits for ten quiet
 * minutes after the last API call and the last reload before touching the
 * profile, and honours the configured interval between checks.
 */
async function idleTick(ctx, session) {
  if (session.busy) return
  const profile = profileDir(ctx)
  const home = powerpackHome(profile)
  let settings
  try {
    settings = await readSettings(home)
  } catch {
    return
  }
  if (settings.updatePolicy !== 'auto-idle') return
  const now = Date.now()
  if (now - session.lastApiAt < AUTO_IDLE_MS) return
  if (now - session.lastReloadAt < AUTO_IDLE_MS) return
  if (now - session.lastCheckAt < settings.checkIntervalHours * 60 * 60 * 1000) return
  session.busy = true
  session.lastCheckAt = now
  try {
    const pin = await readPin(home)
    const installed = await installedVersion(profile)
    const latest = await lookupLatest(profile, defaultExec, { timeout: 60000 })
    await writePin(home, { ...pin, latestKnown: latest.version, checkedAt: new Date().toISOString() })
    const decision = decideUpgrade({ pinned: installed || pin.requested, latest: latest.version, policy: settings.updatePolicy, runningTurns: 0 })
    if (decision.action === 'upgrade') {
      await appendLog(home, 'info', 'rea.auto-update', { from: installed, to: latest.version })
      const result = await upgradeRea(home, profile, latest.version, { exec: defaultExec, log: loggerFor(home) })
      await reloadRow(ctx, home)
      session.lastReloadAt = Date.now()
      await appendLog(home, 'info', 'rea.auto-update.done', { from: result.from, to: result.to })
    }
  } catch (error) {
    await appendLog(home, 'warn', 'rea.auto-update.failed', { code: codeOf(error), message: messageOf(error) }).catch(() => {})
  } finally {
    session.busy = false
  }
}

/** Poll cadence; the real cadence comes from settings.checkIntervalHours. */
const TICK_MS = 5 * 60 * 1000

// ------------------------------------------------------------------ plugin --

export function apply(ctx) {
  const session = { lastApiAt: Date.now(), lastReloadAt: 0, lastCheckAt: 0, busy: false }
  const handler = createHandler(ctx, session)

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: handler }),
    SELF + ': management API',
  )

  ctx.effect(() => {
    const timer = setInterval(() => {
      idleTick(ctx, session).catch(() => {})
    }, TICK_MS)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, SELF + ': idle update check')
}

export default { name: name, inject: inject, apply: apply }
