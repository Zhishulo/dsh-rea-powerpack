/**
 * Version pinning, update policy and the MCP handshake probe.
 *
 * The pin file is the only record of which rea-agents build this profile is
 * supposed to run. Upgrades are always shadow-preflighted and rolled back on a
 * failed handshake; nothing here skips that.
 *
 * @see ARCHITECTURE.md §5 (lib/pin.js)
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { coded, defaultExec, powerpackHome, readManifest, writeSettings } from './engines.js'
import { composeEnv, readSettings } from './engines.js'
import { PACKAGE_NAME, PACKAGE_VERSION } from './version.js'

/** Budget for one pnpm install (15 minutes). */
export const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
/** Budget for the staging preflight handshake. */
export const PREFLIGHT_TIMEOUT_MS = 15 * 1000
/** Budget for the ordinary in-process handshake. */
export const HANDSHAKE_TIMEOUT_MS = 10 * 1000
/** Minimum tool count a REA build must advertise to be considered healthy. */
export const MIN_TOOL_COUNT = 200
/** Package name of the MCP server this plugin owns. */
const PACKAGE = 'rea-agents'
const ENTRY = 'rea-agents/scripts/rea.mjs'

function pinPath(home) {
  return join(home, 'pin.json')
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** Normalize a persisted pin record. */
function normalizePin(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const retained = value.retained && typeof value.retained === 'object' ? value.retained : null
  return {
    version: typeof value.version === 'string' && value.version !== '' ? value.version : null,
    requested: typeof value.requested === 'string' && value.requested !== '' ? value.requested : null,
    pinnedAt: typeof value.pinnedAt === 'string' ? value.pinnedAt : null,
    pinnedFrom: ['cli', 'ui', 'update', 'preflight'].includes(value.pinnedFrom) ? value.pinnedFrom : null,
    retained: retained && typeof retained.from === 'string' ? { from: retained.from, at: typeof retained.at === 'string' ? retained.at : null } : null,
    withheldBuilds: asArray(value.withheldBuilds).filter((id) => typeof id === 'string'),
    latestKnown: typeof value.latestKnown === 'string' ? value.latestKnown : null,
    checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : null,
  }
}

/** Read pin.json (never throws; a missing file becomes an empty pin). */
export async function readPin(home) {
  try {
    return normalizePin(JSON.parse(await readFile(pinPath(home), 'utf8')))
  } catch {
    return normalizePin(null)
  }
}

/** Atomically persist pin.json. */
export async function writePin(home, pin) {
  const value = normalizePin(pin)
  const path = pinPath(home)
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + process.pid + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(temporary, path)
  return value
}

// ---------------------------------------------------------------- versions --

function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference > 0 ? 1 : -1
      continue
    }
    if (aNumeric) return -1
    if (bNumeric) return 1
    if (a !== b) return a > b ? 1 : -1
  }
  return 0
}

/**
 * Semver comparison including prerelease ordering.
 * @returns {-1|0|1} negative when a < b, positive when a > b
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * Decide what an update check should do.
 * @param {{pinned?: string|null, latest?: string|null, policy?: string, runningTurns?: number}} input
 */
export function decideUpgrade(input) {
  const pinned = input && typeof input.pinned === 'string' ? input.pinned : null
  const latest = input && typeof input.latest === 'string' ? input.latest : null
  const policy = input && typeof input.policy === 'string' ? input.policy : 'notify'
  const runningTurns = Number.isFinite(input && input.runningTurns) ? input.runningTurns : 0
  if (!latest) return { action: 'none', reason: 'no_latest_version_known' }
  if (!pinned) return { action: 'none', reason: 'rea_not_installed' }
  const comparison = compareVersions(latest, pinned)
  if (comparison <= 0) return { action: 'none', reason: 'up_to_date' }
  if (policy === 'manual') return { action: 'none', reason: 'manual_policy' }
  if (policy === 'notify') return { action: 'notify', reason: 'newer_version_available' }
  if (runningTurns > 0) return { action: 'notify', reason: 'busy' }
  return { action: 'upgrade', reason: 'newer_version_available' }
}

// ------------------------------------------------------------------- pnpm --

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Locate pnpm without depending on a shell being able to run .cmd shims. */
export function pnpmCommand() {
  const configured = process.env.DSH_PNPM_PATH
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (process.platform !== 'win32') return 'pnpm'
  return 'pnpm.cmd'
}

/** execFile wrapper that keeps Windows .cmd shims usable without shell:true. */
export function runPnpm(exec, args, options = {}) {
  const command = options.command || pnpmCommand()
  const timeout = options.timeout || INSTALL_TIMEOUT_MS
  const cwd = options.cwd
  const base = { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: options.env || process.env }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command, ...args], base)
  }
  if (process.platform === 'win32' && !/[\\/]/.test(command) && command === 'pnpm') {
    return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', ...args], base)
  }
  return exec(command, args, base)
}

/** Extract the first JSON document from noisy pnpm output. */
function parseJsonLoose(stdout) {
  const text = String(stdout || '').trim()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    /* fall through to the brace scan */
  }
  const start = text.search(/[[{]/)
  if (start < 0) return null
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = text.slice(start)
    const cut = attempt === 0 ? candidate.length : candidate.length - attempt
    try {
      return JSON.parse(candidate.slice(0, cut))
    } catch {
      continue
    }
  }
  return null
}

function classifyPnpmFailure(error) {
  const code = error && error.code ? error.code : ''
  const stderr = String((error && (error.stderr || error.stdout)) || '')
  if (code === 'ETIMEDOUT' || /timed out/i.test(stderr)) return coded('registry_timeout', 'pnpm timed out while talking to the registry.')
  if (code === 'ENOENT') return coded('registry_unreachable', 'pnpm was not found. Install pnpm or set DSH_PNPM_PATH.')
  if (/E404|404 Not Found/i.test(stderr)) return coded('no_such_version', 'The registry has no such rea-agents version.')
  if (/ERR_PNPM|ENOTFOUND|ECONNREFUSED|ECONNRESET|proxy/i.test(stderr)) return coded('registry_unreachable', 'The npm registry is unreachable: ' + stderr.split('\n')[0])
  return coded('registry_unreachable', 'pnpm failed: ' + (stderr.split('\n')[0] || (error && error.message) || 'unknown error'))
}

/**
 * Ask the registry for the newest published version.
 * @returns {Promise<{version: string, checkedAt: string}>}
 */
export async function lookupLatest(profileDir, exec = defaultExec, options = {}) {
  const timeout = options.timeout || 60 * 1000
  try {
    const result = await runPnpm(exec, ['view', PACKAGE, 'version', '--json'], { cwd: profileDir, timeout })
    const parsed = parseJsonLoose(result.stdout)
    const version = typeof parsed === 'string' ? parsed : (parsed && typeof parsed.version === 'string' ? parsed.version : null)
    if (!version) throw coded('registry_unreachable', 'pnpm returned no version for ' + PACKAGE)
    return { version, checkedAt: new Date().toISOString() }
  } catch (error) {
    if (error && error.code && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error
    throw classifyPnpmFailure(error)
  }
}

/** Installed rea-agents version on disk (null when absent). */
export async function installedVersion(profileDir) {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'node_modules', PACKAGE, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

// --------------------------------------------------------------- handshake --

/** Resolve the REA entry point inside a profile. */
export function resolveEntry(profileDir) {
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    return require.resolve(ENTRY)
  } catch {
    return null
  }
}

/** Environment for an REA child process: the composed engine env on top of ours. */
async function childEnv(home, overrides) {
  const env = { ...process.env, ...(overrides || {}) }
  try {
    const settings = await readSettings(home)
    const composed = await composeEnv(home, settings)
    for (const [key, value] of Object.entries(composed.env || {})) {
      if (typeof value === 'string' && !(typeof overrides === 'object' && overrides && key in overrides)) env[key] = value
    }
    if (composed.pathPrepend && composed.pathPrepend.length > 0) {
      env.PATH = composed.pathPrepend.join(process.platform === 'win32' ? ';' : ':') + (process.platform === 'win32' ? ';' : ':') + (env.PATH || '')
    }
  } catch {
    /* a broken engine manifest must not break the handshake */
  }
  // Under the desktop harness process.execPath is the Electron binary: it only
  // behaves as node when ELECTRON_RUN_AS_NODE is set for the child.
  if (process.versions && process.versions.electron && !env.ELECTRON_RUN_AS_NODE) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/**
 * Probe one profile with a minimal newline-delimited JSON-RPC MCP client:
 * initialize -> notifications/initialized -> tools/list (following cursors).
 * The child is killed when the deadline expires.
 * @returns {Promise<{serverInfo: object, toolCount: number, toolNames: string[], protocolVersion: string|null}>}
 */
export async function probeServer(profileDir, options = {}) {
  const home = options.home || powerpackHome(profileDir)
  const timeoutMs = options.timeoutMs || HANDSHAKE_TIMEOUT_MS
  const entry = options.entry || resolveEntry(profileDir)
  if (!entry) throw coded('rea_missing', 'rea-agents is not installed in ' + profileDir)
  const env = await childEnv(home, options.env)
  const child = spawn(process.execPath, [entry, 'mcp'], { cwd: profileDir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const toolNames = []
  let serverInfo = null
  let protocolVersion = null

  const outcome = await new Promise((resolvePromise, reject) => {
    let settled = false
    let buffer = ''
    let stderr = ''
    let nextId = 1
    // initialize and tools/list must never share a JSON-RPC id: a duplicate id
    // makes the tools/list reply get handled as the initialize reply, then the
    // client re-sends initialized + tools/list forever.
    let initializeId = 0
    let pendingToolsRequest = null

    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      if (error) reject(error)
      else resolvePromise(value)
    }

    const send = (payload) => {
      if (!child.stdin.writable) return
      child.stdin.write(JSON.stringify(payload) + '\n')
    }

    const requestTools = () => {
      pendingToolsRequest = nextId
      send({ jsonrpc: '2.0', id: nextId, method: 'tools/list', params: {} })
      nextId += 1
    }

    const handle = (message) => {
      if (!message || typeof message !== 'object') return
      if (message.method === 'notifications/message' || message.method === 'notifications/progress') return
      if (message.id === initializeId) {
        if (message.error) return finish(coded('preflight_failed', 'REA initialize failed: ' + JSON.stringify(message.error)))
        serverInfo = (message.result && message.result.serverInfo) || {}
        protocolVersion = message.result && message.result.protocolVersion ? message.result.protocolVersion : null
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        requestTools()
        return
      }
      if (message.id === pendingToolsRequest) {
        if (message.error) return finish(coded('preflight_failed', 'REA tools/list failed: ' + JSON.stringify(message.error)))
        const result = message.result || {}
        for (const tool of Array.isArray(result.tools) ? result.tools : []) {
          if (tool && typeof tool.name === 'string') toolNames.push(tool.name)
        }
        if (result.nextCursor) {
          pendingToolsRequest = nextId
          send({ jsonrpc: '2.0', id: nextId, method: 'tools/list', params: { cursor: result.nextCursor } })
          nextId += 1
          return
        }
        return finish(null, { serverInfo, toolCount: toolNames.length, toolNames, protocolVersion })
      }
    }

    const timer = setTimeout(() => {
      const tail = stderr.trim().split('\n').slice(-3).join(' | ')
      finish(coded('preflight_failed', 'REA handshake timed out after ' + Math.round(timeoutMs / 1000) + 's' + (tail ? ': ' + tail : '')))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.once('error', (error) => finish(coded('rea_missing', 'Could not start REA: ' + error.message)))
    child.once('exit', (code, signal) => {
      const tail = stderr.trim().split('\n').slice(-3).join(' | ')
      finish(coded('rea_missing', 'REA exited before completing the handshake (code ' + code + (signal ? ', ' + signal : '') + ')' + (tail ? ': ' + tail : '')))
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      if (stderr.length > 16384) stderr = stderr.slice(-16384)
    })
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      if (buffer.length > 64 * 1024 * 1024) return finish(coded('preflight_failed', 'REA produced an oversized handshake response'))
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line !== '') {
          try {
            handle(JSON.parse(line))
          } catch {
            /* ignore non-JSON chatter */
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    initializeId = nextId
    nextId += 1
    send({
      jsonrpc: '2.0',
      id: initializeId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: PACKAGE_NAME, version: PACKAGE_VERSION },
      },
    })
  })
  return outcome
}

// ---------------------------------------------------------------- staging --

async function stagingPath(home, version) {
  const directory = join(home, 'staging', String(version))
  await mkdir(directory, { recursive: true })
  const manifestFile = join(directory, 'package.json')
  if (!existsSync(manifestFile)) {
    await writeFile(manifestFile, JSON.stringify({ name: 'rea-powerpack-staging', private: true, version: '0.0.0' }, null, 2) + '\n', 'utf8')
  }
  return directory
}

/** Keep only the newest staging directory; older ones are dead weight. */
async function pruneStaging(home) {
  const root = join(home, 'staging')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const directories = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(root, entry.name)
    try {
      const info = await readFile(join(full, 'package.json'), 'utf8')
      directories.push({ path: full, name: entry.name, mtime: Date.parse(JSON.parse(info).reaPowerpackTouchedAt || '') || 0 })
    } catch {
      directories.push({ path: full, name: entry.name, mtime: 0 })
    }
  }
  directories.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
  const removed = []
  for (const stale of directories.slice(1)) {
    await rm(stale.path, { recursive: true, force: true }).catch(() => {})
    removed.push(stale.path)
  }
  return removed
}

async function preflight(profileDir, home, expectedVersion, log) {
  const probed = await probeServer(profileDir, { home, timeoutMs: PREFLIGHT_TIMEOUT_MS })
  const version = probed.serverInfo && probed.serverInfo.version ? probed.serverInfo.version : null
  const toolCount = probed.toolCount
  if (version !== expectedVersion) {
    throw coded('preflight_failed', 'Staging build reports version ' + String(version) + ' instead of ' + expectedVersion)
  }
  if (toolCount < MIN_TOOL_COUNT) {
    throw coded('preflight_failed', 'Staging build advertised only ' + toolCount + ' tools (need at least ' + MIN_TOOL_COUNT + ')')
  }
  if (typeof log === 'function') await log('info', 'pin.preflight', { version, toolCount })
  return { serverVersion: version, toolCount }
}

/**
 * Upgrade rea-agents: stage -> preflight handshake -> install -> handshake -> pin.
 * A failed post-install handshake rolls the profile back to the previous build.
 * @param {string} home
 * @param {string} profileDir
 * @param {string} version exact version to install
 * @param {{exec?: Function, log?: Function}} [options]
 */
export async function upgradeRea(home, profileDir, version, options = {}) {
  const exec = options.exec || defaultExec
  const log = typeof options.log === 'function' ? options.log : async () => {}
  const target = String(version || '').trim()
  if (!parseVersion(target)) throw coded('bad_request', 'Not a valid version: ' + target)
  const pin = await readPin(home)
  if (pin.requested && pin.requested !== target) {
    throw coded('pin_conflict', 'This profile is pinned to ' + pin.requested + '; unpin it before installing ' + target + '.')
  }
  const from = await installedVersion(profileDir)
  const staged = await stagingPath(home, target)
  try {
    await runPnpm(exec, ['add', '--save-exact', PACKAGE + '@' + target], { cwd: staged, timeout: INSTALL_TIMEOUT_MS })
    const stagedVersion = await installedVersion(staged)
    if (stagedVersion !== target) {
      throw coded('install_failed', 'Staging install produced ' + String(stagedVersion) + ' instead of ' + target)
    }
    const before = await preflight(staged, home, target, log)
    await runPnpm(exec, ['add', '--save-exact', PACKAGE + '@' + target], { cwd: profileDir, timeout: INSTALL_TIMEOUT_MS })
    const installed = await installedVersion(profileDir)
    if (installed !== target) {
      throw coded('install_failed', 'Profile install produced ' + String(installed) + ' instead of ' + target)
    }
    let after
    try {
      const probed = await probeServer(profileDir, { home, timeoutMs: PREFLIGHT_TIMEOUT_MS })
      if (probed.toolCount < MIN_TOOL_COUNT) {
        throw coded('preflight_failed', 'Installed build advertised only ' + probed.toolCount + ' tools (need at least ' + MIN_TOOL_COUNT + ')')
      }
      after = { serverVersion: probed.serverInfo && probed.serverInfo.version ? probed.serverInfo.version : null, toolCount: probed.toolCount }
    } catch (error) {
      const withheld = Array.from(new Set([...pin.withheldBuilds, target]))
      await writePin(home, { ...pin, withheldBuilds: withheld })
      if (from) {
        try {
          await rollback(home, profileDir, { exec, log, to: from })
        } catch (rollbackError) {
          throw coded('rollback_failed', 'Upgrade to ' + target + ' failed (' + (error && error.message ? error.message : String(error)) + ') and rollback to ' + from + ' also failed: ' + (rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError)))
        }
      }
      throw coded('preflight_failed', 'Upgrade to ' + target + ' failed and was rolled back to ' + String(from) + ': ' + (error && error.message ? error.message : String(error)))
    }
    const now = new Date().toISOString()
    await writePin(home, {
      version: target,
      requested: target,
      pinnedAt: now,
      pinnedFrom: 'update',
      retained: from && from !== target ? { from, at: now } : null,
      withheldBuilds: pin.withheldBuilds.filter((id) => id !== target),
      latestKnown: pin.latestKnown && compareVersions(pin.latestKnown, target) > 0 ? pin.latestKnown : target,
      checkedAt: now,
    })
    await log('info', 'pin.upgrade', { from, to: target, toolCount: after.toolCount })
    return { ok: true, from, to: target, preflight: before, handshake: after }
  } finally {
    await pruneStaging(home).catch(() => {})
  }
}

/**
 * Roll the profile back to the retained (or explicitly requested) build.
 * @param {string} home
 * @param {string} profileDir
 * @param {{exec?: Function, log?: Function, to?: string}} [options]
 */
export async function rollback(home, profileDir, options = {}) {
  const exec = options.exec || defaultExec
  const log = typeof options.log === 'function' ? options.log : async () => {}
  const pin = await readPin(home)
  const current = await installedVersion(profileDir)
  const target = options.to || (pin.retained && pin.retained.from) || pin.version
  if (!target) throw coded('rollback_failed', 'No retained version to roll back to.')
  if (!parseVersion(target)) throw coded('rollback_failed', 'Retained version is not a valid semver: ' + target)
  await runPnpm(exec, ['add', '--save-exact', PACKAGE + '@' + target], { cwd: profileDir, timeout: INSTALL_TIMEOUT_MS })
  const installed = await installedVersion(profileDir)
  if (installed !== target) throw coded('rollback_failed', 'Rollback installed ' + String(installed) + ' instead of ' + target)
  const probed = await probeServer(profileDir, { home, timeoutMs: PREFLIGHT_TIMEOUT_MS })
  if (probed.toolCount < MIN_TOOL_COUNT) {
    throw coded('rollback_failed', 'Rolled back build advertised only ' + probed.toolCount + ' tools.')
  }
  const now = new Date().toISOString()
  await writePin(home, {
    version: target,
    requested: target,
    pinnedAt: now,
    pinnedFrom: 'update',
    retained: null,
    withheldBuilds: Array.from(new Set([...pin.withheldBuilds, ...(current && current !== target ? [current] : [])])),
    latestKnown: pin.latestKnown,
    checkedAt: now,
  })
  await log('info', 'pin.rollback', { from: current, to: target })
  return { ok: true, from: current, to: target, toolCount: probed.toolCount }
}
