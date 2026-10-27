/**
 * Engine detection, installation, verification and environment composition.
 *
 * Everything that touches the filesystem, the network or a child process lives
 * here. catalog.js stays pure data; index.js stays HTTP orchestration.
 *
 * @see ARCHITECTURE.md §5 (lib/engines.js)
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs'
import { access, appendFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { constants as FS } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'

import { byId, forPlatform, ENGINES } from './catalog.js'

/** Download budget for a single engine artifact (60 minutes: adb/Ghidra-sized archives). */
export const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000
/** Extraction budget for a downloaded archive. */
export const EXTRACT_TIMEOUT_MS = 60 * 60 * 1000
/** winget / pip budget. */
export const PACKAGE_INSTALL_TIMEOUT_MS = 30 * 60 * 1000
/** Per-probe wall clock. */
export const PROBE_TIMEOUT_MS = 20 * 1000

/** Default settings written when settings.json is absent. */
export const DEFAULT_SETTINGS = {
  updatePolicy: 'notify',
  toolTimeoutMs: 900000,
  checkIntervalHours: 6,
  engineRoot: null,
  locale: 'auto',
}

const MANIFEST_VERSION = 1
const USER_AGENT = 'dsh-rea-powerpack/0.1.0'

// --------------------------------------------------------------- utilities --

/**
 * Build an Error carrying a stable error code from the ARCHITECTURE enum.
 * @param {string} code
 * @param {string} [message]
 * @param {Record<string, unknown>} [extra]
 */
export function coded(code, message, extra) {
  const error = new Error(message || code)
  error.code = code
  if (extra && typeof extra === 'object') Object.assign(error, extra)
  return error
}

/**
 * promisified execFile that keeps stdout/stderr on the rejection for diagnostics.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptions} [options]
 */
export function defaultExec(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolvePromise({ stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** Truncate a diagnostic string. */
function clip(value, limit = 4096) {
  const text = String(value ?? '')
  return text.length <= limit ? text : text.slice(0, limit) + '\u2026'
}

/** Expand %VAR% / dollar-brace VAR / ~ in a configured path. */
function expandEnvPath(value) {
  let out = String(value)
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = join(homedir(), out.slice(2))
  out = out.replace(/%([^%]+)%/g, (match, name) => {
    const found = process.env[name]
    return typeof found === 'string' && found !== '' ? found : match
  })
  out = out.replace(/\$\{([^}]+)\}/g, (match, name) => {
    const found = process.env[name]
    return typeof found === 'string' && found !== '' ? found : match
  })
  return out
}

/** Resolve an environment-value path candidate, or null when absent. */
function envCandidate(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const expanded = expandEnvPath(value.trim())
  if (expanded === '' || !isAbsolute(expanded)) return null
  return expanded
}

/** Synchronous, cheap existence predicates (detect() must not await probes). */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Locate an executable on PATH (PATHEXT-aware, no shell). */
function findOnPath(name) {
  if (typeof name !== 'string' || name === '') return null
  if (isAbsolute(name)) return existsSync(name) ? name : null
  const rawPath = process.env.PATH || ''
  const dirs = rawPath.split(delimiter).filter((dir) => dir !== '')
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
    : ['']
  const hasExt = /\.[A-Za-z0-9]+$/.test(name)
  for (const dir of dirs) {
    if (hasExt) {
      const candidate = join(dir, name)
      if (isFile(candidate)) return candidate
      continue
    }
    for (const ext of exts) {
      const lower = join(dir, name + ext.toLowerCase())
      if (isFile(lower)) return lower
      const upper = join(dir, name + ext)
      if (upper !== lower && isFile(upper)) return upper
    }
  }
  return null
}

function isUnder(child, root) {
  if (typeof child !== 'string' || typeof root !== 'string') return false
  const a = resolve(child).toLowerCase()
  const b = resolve(root).toLowerCase()
  if (process.platform !== 'win32') return a === b || a.startsWith(b + sep)
  return a === b || a.startsWith(b + sep) || a.startsWith(b + '/')
}

/** First semver-ish token in version output. */
export function versionFromOutput(output) {
  const text = String(output || '')
  const semver = text.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]*)?\b/)
  if (semver) return semver[0]
  const dotted = text.match(/\b\d+(?:\.\d+)+\b/)
  return dotted ? dotted[0] : null
}

/** Whether a probe's combined output satisfies the spec's match. */
function probeMatches(spec, output) {
  const expected = spec.probe && spec.probe.match
  if (!expected) return true
  if (typeof output !== 'string') return false
  if (output.includes(expected)) return true
  try {
    return new RegExp(expected, 'i').test(output)
  } catch {
    return false
  }
}

// ------------------------------------------------------------ state files --

/** Machine-level state directory shared by every DSH profile. */
export function powerpackHome(profileDir) {
  const configured = process.env.REA_POWERPACK_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim())
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(base, 'rea-powerpack')
  }
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'rea-powerpack')
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(stateHome, 'rea-powerpack')
}

/** Directory holding every managed engine (settings.engineRoot wins). */
export function engineRoot(home, settings) {
  const configured = settings && typeof settings.engineRoot === 'string' && settings.engineRoot.trim() !== ''
    ? expandEnvPath(settings.engineRoot.trim())
    : null
  if (configured && isAbsolute(configured)) return resolve(configured)
  return join(home, 'engines')
}

function manifestPath(home) {
  return join(home, 'engines.json')
}

export function settingsPath(home) {
  return join(home, 'settings.json')
}

export function statePath(home) {
  return join(home, 'state.json')
}

function logPath(home) {
  return join(home, 'logs', 'powerpack.log')
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function writeFileAtomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp'
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** Append one JSONL diagnostic line; never throws, never records secrets. */
export async function appendLog(home, level, event, detail) {
  try {
    await mkdir(dirname(logPath(home)), { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), level: level || 'info', event: String(event || ''), detail: detail === undefined ? null : detail }) + '\n'
    await appendFile(logPath(home), line, 'utf8')
  } catch {
    /* logging must never break an API call */
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizeRecord(record) {
  return {
    id: String(record.id),
    name: typeof record.name === 'string' ? record.name : record.id,
    tier: Number.isInteger(record.tier) ? record.tier : 2,
    version: typeof record.version === 'string' ? record.version : null,
    path: typeof record.path === 'string' ? record.path : null,
    envVar: typeof record.envVar === 'string' ? record.envVar : null,
    pathPrepend: record.pathPrepend === true,
    sha256: typeof record.sha256 === 'string' ? record.sha256 : null,
    verified: record.verified === true,
    rawVersionOutput: typeof record.rawVersionOutput === 'string' ? record.rawVersionOutput : null,
    extraEnv: record.extraEnv && typeof record.extraEnv === 'object' && !Array.isArray(record.extraEnv) ? record.extraEnv : undefined,
    installedAt: typeof record.installedAt === 'string' ? record.installedAt : null,
    source: typeof record.source === 'string' ? record.source : 'unknown',
  }
}

/** Read engines.json, synthesising the documented shape when it is absent. */
export async function readManifest(home) {
  if (typeof home !== 'string' || home === '') throw coded('bad_request', 'powerpackHome is unknown')
  const raw = await readJsonFile(manifestPath(home))
  const fallbackRoot = join(home, 'engines')
  if (!raw || typeof raw !== 'object') return { version: MANIFEST_VERSION, root: fallbackRoot, updatedAt: null, engines: [] }
  return {
    version: MANIFEST_VERSION,
    root: typeof raw.root === 'string' && raw.root !== '' ? raw.root : fallbackRoot,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    engines: asArray(raw.engines).filter((record) => record && typeof record.id === 'string').map(normalizeRecord),
  }
}

/** Atomically persist engines.json. */
export async function writeManifest(home, manifest) {
  const value = {
    version: MANIFEST_VERSION,
    root: manifest && typeof manifest.root === 'string' ? manifest.root : join(home, 'engines'),
    updatedAt: new Date().toISOString(),
    engines: asArray(manifest && manifest.engines).filter((record) => record && typeof record.id === 'string').map(normalizeRecord),
  }
  await writeFileAtomic(manifestPath(home), JSON.stringify(value, null, 2) + '\n')
  return value
}

/** Read settings.json merged over the documented defaults. */
export async function readSettings(home) {
  const raw = (await readJsonFile(settingsPath(home))) || {}
  const settings = { ...DEFAULT_SETTINGS }
  if (raw && typeof raw === 'object') {
    if (['notify', 'auto-idle', 'manual'].includes(raw.updatePolicy)) settings.updatePolicy = raw.updatePolicy
    if (Number.isFinite(raw.toolTimeoutMs) && raw.toolTimeoutMs >= 1000) settings.toolTimeoutMs = Math.min(raw.toolTimeoutMs, 24 * 60 * 60 * 1000)
    if (Number.isFinite(raw.checkIntervalHours) && raw.checkIntervalHours > 0) settings.checkIntervalHours = Math.min(raw.checkIntervalHours, 24 * 7)
    settings.engineRoot = typeof raw.engineRoot === 'string' && raw.engineRoot.trim() !== '' ? raw.engineRoot : null
    if (['auto', 'zh', 'en'].includes(raw.locale)) settings.locale = raw.locale
  }
  return settings
}

/** Write a partial settings patch; returns the merged settings. */
export async function writeSettings(home, patch) {
  const current = await readSettings(home)
  const next = { ...current }
  if (patch && typeof patch === 'object') {
    if (['notify', 'auto-idle', 'manual'].includes(patch.updatePolicy)) next.updatePolicy = patch.updatePolicy
    if (Number.isFinite(patch.toolTimeoutMs) && patch.toolTimeoutMs >= 1000) next.toolTimeoutMs = Math.min(patch.toolTimeoutMs, 24 * 60 * 60 * 1000)
    if (Number.isFinite(patch.checkIntervalHours) && patch.checkIntervalHours > 0) next.checkIntervalHours = Math.min(patch.checkIntervalHours, 24 * 7)
    if (patch.engineRoot === null) next.engineRoot = null
    else if (typeof patch.engineRoot === 'string' && patch.engineRoot.trim() !== '') next.engineRoot = expandEnvPath(patch.engineRoot.trim())
    if (['auto', 'zh', 'en'].includes(patch.locale)) next.locale = patch.locale
  }
  await writeFileAtomic(settingsPath(home), JSON.stringify(next, null, 2) + '\n')
  return next
}

/** Read state.json (doctor/reload caches). */
export async function readState(home) {
  const raw = (await readJsonFile(statePath(home))) || {}
  const value = { lastDoctor: null, lastReload: null }
  if (raw && typeof raw === 'object') {
    if (raw.lastDoctor && typeof raw.lastDoctor === 'object') value.lastDoctor = raw.lastDoctor
    if (raw.lastReload && typeof raw.lastReload === 'object') value.lastReload = raw.lastReload
  }
  return value
}

/** Merge and persist state.json. */
export async function writeState(home, patch) {
  const current = await readState(home)
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  await writeFileAtomic(statePath(home), JSON.stringify(next, null, 2) + '\n')
  return next
}

// --------------------------------------------------------------- manifest --

/** Look up a persisted record by engine id. */
function recordFor(manifest, id) {
  return manifest.engines.find((record) => record.id === id) || null
}

/** Replace (or append) one record in the manifest body. */
function upsertRecord(manifest, record) {
  const engines = manifest.engines.slice()
  const index = engines.findIndex((candidate) => candidate.id === record.id)
  if (index >= 0) engines[index] = record
  else engines.push(record)
  return { ...manifest, updatedAt: new Date().toISOString(), engines }
}

/** Remove one record from the manifest body. */
function dropRecord(manifest, id) {
  return { ...manifest, updatedAt: new Date().toISOString(), engines: manifest.engines.filter((record) => record.id !== id) }
}

// -------------------------------------------------------------- resolution --

/** Managed install directory for a spec inside the engine root. */
function managedDir(spec, root) {
  const install = spec.install
  if (!install) return null
  const dest = spec.dest || spec.id
  if (install.kind === 'zip') return install.stripRoot ? join(root, dest) : join(root, dest)
  if (install.kind === 'file') return join(root, dest ? dirname(dest) : spec.id)
  if (install.kind === 'github-latest') return join(root, dest ? dirname(dest) : spec.id)
  if (install.kind === 'pip') return null
  return null
}

/** Expected file path for an engine installed from an archive or a direct file. */
function managedPath(spec, root) {
  const install = spec.install
  if (!install) return null
  const dest = install.dest || spec.dest || spec.id
  const binary = install.binary || spec.binary || null
  if (install.kind === 'file') return join(root, dest)
  if (install.kind === 'github-latest') {
    // A generated launcher (apktool.cmd) is what the env var must point at.
    if (spec.launcher) return join(root, spec.launcher)
    return join(root, dest)
  }
  if (install.kind === 'zip') {
    const directory = join(root, dest)
    if (binary) return join(directory, binary)
    return directory
  }
  return null
}

/** Remove a leading path separator from an archive-relative marker. */
function relativeMarker(value) {
  return String(value).replace(/^[/\\]+/, '').replace(/\\/g, '/')
}

/**
 * Files that prove an engine directory is the right one: the probe's path after
 * {dir}/ plus any explicit spec.files markers.
 * @returns {string[]} archive-relative markers
 */
function directoryMarkers(spec) {
  const markers = []
  for (const file of asArray(spec.files)) markers.push(relativeMarker(file))
  const exe = spec.probe && spec.probe.exe
  if (typeof exe === 'string' && exe.includes('{dir}')) {
    const tail = exe.split('{dir}').pop()
    if (tail) markers.push(relativeMarker(tail))
  }
  return markers
}

/** True when a directory carries every marker the engine needs. */
function directoryFits(dir, spec) {
  if (!isDir(dir)) return false
  const markers = directoryMarkers(spec)
  if (!markers.length) return true
  return markers.every((marker) => isFile(join(dir, marker.split('/').join(sep))))
}

/** Expand %VAR% references; unknown variables are left untouched. */
function expandEnvironment(value) {
  return String(value).replace(/%([^%]+)%/g, (match, name) => {
    const direct = process.env[name]
    if (typeof direct === 'string' && direct !== '') return direct
    const upper = process.env[name.toUpperCase()]
    if (typeof upper === 'string' && upper !== '') return upper
    return match
  })
}

/** Expand the last path segment as a single-level wildcard (jdk-*). */
function expandWildcard(pattern) {
  const directory = dirname(pattern)
  const leaf = basename(pattern)
  if (!isDir(directory) || !leaf.includes('*')) return []
  const source = leaf.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '.')
  let expression
  try {
    expression = new RegExp('^' + source + '$', 'i')
  } catch {
    return []
  }
  try {
    return readdirSync(directory).filter((name) => expression.test(name)).map((name) => join(directory, name)).sort()
  } catch {
    return []
  }
}
/**
 * Turn the spec's string locate hints into concrete candidates. A hint may be a
 * file, a directory that *contains* the engine, or a wildcard segment.
 */
function locateCandidates(spec, root) {
  const out = []
  for (const raw of asArray(spec.locate)) {
    if (typeof raw !== 'string' || raw === '') continue
    const expanded = expandEnvironment(raw)
    if (expanded.includes('*') || expanded.includes('?')) {
      for (const match of expandWildcard(expanded)) {
        if (directoryFits(match, spec) || candidateFits(spec, match)) out.push(match)
      }
      continue
    }
    if (spec.envKind === 'dir' || spec.files) {
      if (directoryFits(expanded, spec)) {
        out.push(expanded)
        continue
      }
      // The hint is a parent folder: look one level down (Program Files\Java\jdk-21).
      if (isDir(expanded)) {
        for (const name of safeReaddir(expanded)) {
          const child = join(expanded, name)
          if (directoryFits(child, spec)) out.push(child)
        }
      }
      if (isFile(expanded)) out.push(expanded)
      continue
    }
    if (isFile(expanded)) {
      out.push(expanded)
      continue
    }
    if (isDir(expanded)) {
      const base = executableBasename(spec)
      if (base) {
        for (const name of safeReaddir(expanded)) {
          const child = join(expanded, name)
          if (basename(child).toLowerCase() === base.toLowerCase() && isFile(child)) out.push(child)
        }
      }
    }
  }
  return out
}

/** File name the probe shell expects, e.g. javac.exe from {dir}/bin/javac.exe. */
function executableBasename(spec) {
  const exe = spec.probe && spec.probe.exe
  if (typeof exe !== 'string' || exe === '' || exe === '{path}') return null
  const base = basename(exe.replace(/\{dir\}|\{path\}/g, ''))
  return base && base !== '.' ? base : null
}

function safeReaddir(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}
/**
 * Every plausible location for an engine, most authoritative first.
 * @param {import('./catalog.js').EngineSpec} spec
 * @param {string} root
 * @param {{path?: string|null}} [record]
 */
function candidatesFor(spec, root, record) {
  const list = []
  const push = (value) => {
    if (typeof value !== 'string' || value === '') return
    if (!list.some((existing) => existing.toLowerCase() === value.toLowerCase())) list.push(value)
  }
  if (record && record.path) push(record.path)
  if (spec.envVar) push(envCandidate(process.env[spec.envVar]))
  const managed = managedPath(spec, root)
  if (managed) push(managed)
  if (spec.locate) {
    if (typeof spec.locate === 'function') {
      push(spec.locate({ root, join, findOnPath, isFile, isDir }))
    } else {
      for (const candidate of locateCandidates(spec, root)) push(candidate)
    }
  }
  const executable = spec.probe && spec.probe.exe
  if (executable && !isAbsolute(executable)) {
    const dir = managedDir(spec, root)
    if (dir && isFile(join(dir, executable))) push(join(dir, executable))
    push(findOnPath(executable))
  } else if (executable && isAbsolute(executable)) {
    if (isFile(executable)) push(executable)
  }
  if (spec.probe && Array.isArray(spec.probe.args)) {
    for (const arg of spec.probe.args) {
      if (typeof arg === 'string' && isAbsolute(arg) && isFile(arg)) push(arg)
    }
  }
  return list
}

/** True when the candidate satisfies the spec's env kind. */
function candidateFits(spec, candidate) {
  if (!candidate) return false
  if (spec.envKind === 'dir') return directoryFits(candidate, spec)
  if (spec.envKind === 'file') return isFile(candidate) || isDir(candidate)
  if (spec.probe && spec.probe.exe) return isFile(candidate)
  return isFile(candidate) || isDir(candidate)
}

/** The path the environment composer should export for this spec. */
function envPathFor(spec, resolved) {
  if (!resolved) return null
  if (spec.envKind === 'dir') return isDir(resolved) ? resolved : dirname(resolved)
  return resolved
}

// --------------------------------------------------------------- detection --

/** Cheap, non-executing resolution of one engine spec. */
function locateEngine(spec, root, record) {
  const candidates = candidatesFor(spec, root, record)
  for (const candidate of candidates) {
    if (candidateFits(spec, candidate)) return candidate
  }
  return null
}

/** Whether an engine has a probe usable by verifyAll(). */
function probeFor(spec, resolved) {
  const probe = spec.probe
  if (!probe) return null
  const dir = resolved ? (isDir(resolved) ? resolved : dirname(resolved)) : null
  const expand = (value) => String(value).replace(/\{dir\}/g, dir || '').replace(/\{path\}/g, resolved || '')
  const declared = probe.exe || ''
  const preferResolved = resolved && isFile(resolved) && !declared.includes('{') && !isAbsolute(declared)
  const command = preferResolved ? resolved : expand(declared || resolved || '')
  if (!command || command.includes('{')) return null
  const args = (Array.isArray(probe.args) ? probe.args : []).map((arg) => (typeof arg === 'string' ? expand(arg) : String(arg)))
  return { command, args }
}

/** Execute one probe (20 s budget) and report its raw observation. */
async function runProbe(spec, resolved, exec, env) {
  const target = probeFor(spec, resolved)
  if (!target) return { ok: false, output: null, reason: 'no_probe' }
  // execFile refuses .cmd/.bat on Windows, so generated launchers go via cmd.exe.
  const scripted = /\.(cmd|bat)$/i.test(String(target.command))
  const command = scripted ? process.env.ComSpec || 'cmd.exe' : target.command
  const args = scripted ? ['/d', '/s', '/c', target.command, ...target.args] : target.args
  try {
    const probeOptions = { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    if (env && typeof env === 'object') probeOptions.env = { ...process.env, ...env }
    const result = await exec(command, args, probeOptions)
    const output = clip(String(result.stdout || '') + String(result.stderr || ''), 4096)
    if (!probeMatches(spec, output)) return { ok: false, output, reason: 'output_mismatch' }
    return { ok: true, output, version: versionFromOutput(output) }
  } catch (error) {
    const output = clip(String(error && error.stdout ? error.stdout : '') + String(error && error.stderr ? error.stderr : '') + String(error && error.message ? error.message : ''), 4096)
    return { ok: false, output, reason: error && error.code === 'ETIMEDOUT' ? 'timeout' : 'exec_failed' }
  }
}

/** Probe an already-installed engine without writing anything. */
export async function probeEngine(spec, root, record, exec = defaultExec, env) {
  const resolved = locateEngine(spec, root, record)
  if (!resolved) return { ok: false, status: 'missing', path: null, output: null }
  const probed = await runProbe(spec, resolved, exec, env)
  return { ok: probed.ok, status: probed.ok ? 'ok' : 'broken', path: resolved, output: probed.output, version: probed.version, reason: probed.reason }
}

/** A short, actionable remediation sentence for an engine. */
function remedyFor(spec, status) {
  if (status === 'unsupported_host') return spec.notes || 'This engine is not supported on Windows.'
  if (status === 'requires_dependency') {
    const deps = (spec.requires || []).join(', ')
    return 'Install the required engine(s) first: ' + deps + '.'
  }
  if (spec.install) return 'Install ' + spec.name + ' from the engine matrix (POST /engines/install).'
  if (spec.envVar) return 'Point ' + spec.envVar + ' at an existing ' + spec.name + ' installation.'
  return (spec.notes || 'Install ' + spec.name + ' manually and restart DSH.')
}

/** Dependency ids for a spec that are not present in the manifest as verified. */
function unmetRequires(spec, manifest) {
  const requires = Array.isArray(spec.requires) ? spec.requires : []
  return requires.filter((id) => {
    const record = recordFor(manifest, id)
    if (record && record.verified) return false
    const dependency = byId(id)
    if (!dependency) return true
    const root = manifest.root || ''
    return locateEngine(dependency, root, record) === null
  })
}

/**
 * Detect every catalog engine for a platform without executing anything.
 * @param {string} home powerpackHome()
 * @param {object} settings
 * @param {string} [platform]
 * @param {object} [manifest] pre-read manifest (avoids a second disk read)
 */
export async function detect(home, settings, platform = process.platform, manifest) {
  const current = manifest || (await readManifest(home))
  const root = engineRoot(home, settings)
  const specs = forPlatform(platform, process.env)
  const present = new Map(current.engines.map((record) => [record.id, record]))
  const statuses = []
  for (const spec of specs) {
    const record = present.get(spec.id) || null
    const resolved = locateEngine(spec, root, record)
    const unsupported = spec.hostUnsupported === platform
    let status
    if (unsupported) status = 'unsupported_host'
    else if (resolved) status = spec.install ? 'ok' : 'external_ok'
    else if (record && record.path) status = spec.install ? 'broken' : 'external_missing'
    else status = spec.install ? 'missing' : 'external_missing'
    statuses.push({
      spec,
      record,
      status,
      path: resolved,
      version: record && record.version ? record.version : null,
      output: record && record.rawVersionOutput ? record.rawVersionOutput : undefined,
    })
  }
  const byIdMap = new Map(statuses.map((entry) => [entry.spec.id, entry]))
  for (const entry of statuses) {
    if (entry.status === 'unsupported_host' || entry.status === 'ok' || entry.status === 'external_ok') continue
    const unmet = unmetRequires(entry.spec, current)
    if (unmet.length > 0) {
      entry.status = 'requires_dependency'
      entry.unmet = unmet
    }
  }
  return { statuses, byId: byIdMap, manifest: current, root }
}

/** Map a detection entry to the EngineStatus wire shape. */
export function engineStatus(entry, platform = process.platform) {
  const spec = entry.spec
  const record = entry.record || null
  const status = entry.status
  const installable = Boolean(
    spec.install &&
    (status === 'missing' || status === 'broken') &&
    spec.hostUnsupported !== platform &&
    (!entry.unmet || entry.unmet.length === 0),
  )
  const managed = Boolean(
    spec.install && entry.path && (isUnder(entry.path, entry.root || '') || (record && record.source === spec.install.kind)),
  )
  const wire = {
    id: spec.id,
    name: spec.name,
    tier: spec.tier,
    status,
    version: entry.version || null,
    path: entry.path || null,
    envVar: spec.envVar || null,
    remedy: remedyFor(spec, status),
    installable,
    managed,
  }
  if (entry.output) wire.probeOutput = entry.output
  if (spec.docs) wire.docs = spec.docs
  if (spec.notes) wire.notes = spec.notes
  if (entry.unmet && entry.unmet.length > 0) wire.requires = entry.unmet
  return wire
}

/**
 * Probe every engine and persist the results. This is the only routine that
 * executes third-party binaries from /state-adjacent code paths.
 * @param {string} home
 * @param {object} settings
 * @param {{exec?: Function, platform?: string, ids?: string[], log?: Function}} [options]
 */
export async function verifyAll(home, settings, options = {}) {
  const exec = options.exec || defaultExec
  const platform = options.platform || process.platform
  const log = typeof options.log === 'function' ? options.log : async () => {}
  const manifest = await readManifest(home)
  const root = engineRoot(home, settings)
  const detection = await detect(home, settings, platform, manifest)
  const wanted = Array.isArray(options.ids) && options.ids.length > 0 ? new Set(options.ids) : null
  const composed = await composeEnv(home, settings)
  const probeEnv = options.env || (composed && composed.env ? composed.env : {})
  let next = { ...manifest, root }
  const results = []
  for (const entry of detection.statuses) {
    if (wanted && !wanted.has(entry.spec.id)) {
      results.push({ id: entry.spec.id, status: entry.status, verified: Boolean(entry.record && entry.record.verified), skipped: true })
      continue
    }
    if (entry.spec.hostUnsupported === platform) {
      results.push({ id: entry.spec.id, status: 'unsupported_host', verified: false })
      continue
    }
    if (!entry.path || !entry.spec.probe) {
      const existing = entry.record
      const verified = Boolean(existing && existing.verified && entry.path)
      if (existing && entry.path) next = upsertRecord(next, { ...existing, path: entry.path, verified })
      results.push({ id: entry.spec.id, status: entry.status, verified, path: entry.path })
      continue
    }
    const probed = await runProbe(entry.spec, entry.path, exec, probeEnv)
    const record = {
      id: entry.spec.id,
      name: entry.spec.name,
      tier: entry.spec.tier,
      version: probed.version || (entry.record && entry.record.version) || null,
      path: entry.path,
      envVar: entry.spec.envVar || null,
      pathPrepend: entry.spec.pathPrepend === true,
      sha256: (entry.record && entry.record.sha256) || null,
      verified: probed.ok,
      rawVersionOutput: probed.output || null,
      installedAt: (entry.record && entry.record.installedAt) || null,
      source: (entry.record && entry.record.source) || 'detected',
    }
    next = upsertRecord(next, record)
    results.push({ id: entry.spec.id, status: probed.ok ? (entry.spec.install ? 'ok' : 'external_ok') : 'broken', verified: probed.ok, path: entry.path, version: probed.version || null, output: probed.output || null, reason: probed.reason })
    await log('info', 'engine.verify', { id: entry.spec.id, verified: probed.ok, reason: probed.reason || null })
  }
  const written = await writeManifest(home, next)
  return { ok: true, root, results, manifest: written }
}

/** Whether the state directory can actually be written to. */
export async function isWritable(home) {
  try {
    await mkdir(home, { recursive: true })
    const probeFile = join(home, '.write-probe-' + process.pid)
    await writeFile(probeFile, 'ok', 'utf8')
    await rm(probeFile, { force: true })
    return true
  } catch {
    return false
  }
}

// --------------------------------------------------------------- download --

/** Proxy URL from the environment (must not be hard-coded). */
function proxyUrlFor(target) {
  const raw = target.protocol === 'https:'
    ? (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '')
    : (process.env.HTTP_PROXY || process.env.http_proxy || '')
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (!/^https?:$/.test(parsed.protocol)) return null
    return parsed
  } catch {
    return null
  }
}

/** Basic proxy authorization header, if the proxy URL carries credentials. */
function proxyAuthHeader(proxy) {
  if (!proxy || !proxy.username) return {}
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password || '')
  return { 'proxy-authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') }
}

/** One HTTP(S) GET, following redirects manually so we can keep the timeout budget. */
function openRequest(target, timeoutMs) {
  const proxy = proxyUrlFor(target)
  if (proxy && target.protocol === 'https:') {
    return new Promise((resolvePromise, reject) => {
      const connectRequest = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method: 'CONNECT',
        path: target.hostname + ':' + (target.port || 443),
        headers: { host: target.hostname + ':' + (target.port || 443), ...proxyAuthHeader(proxy) },
      })
      connectRequest.setTimeout(timeoutMs, () => connectRequest.destroy(coded('download_failed', 'Proxy CONNECT timed out')))
      connectRequest.once('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy()
          reject(coded('download_failed', 'Proxy CONNECT failed with HTTP ' + response.statusCode))
          return
        }
        const secure = tls.connect({ socket, servername: target.hostname })
        secure.once('secureConnect', () => resolvePromise({ request: () => https.request(target, { createConnection: () => secure, headers: { 'user-agent': USER_AGENT } }), stream: secure }))
        secure.once('error', (error) => reject(coded('download_failed', 'TLS through proxy failed: ' + error.message)))
      })
      connectRequest.once('error', () => {
        const direct = https.request(target, { headers: { 'user-agent': USER_AGENT } })
        resolvePromise({ request: () => direct, stream: null, direct: true })
      })
      connectRequest.end()
    })
  }
  return Promise.resolve({ request: () => (target.protocol === 'https:' ? https : http).request(target, { headers: { 'user-agent': USER_AGENT } }), stream: null })
}

/**
 * Stream a URL into an async iterator of Buffers, following up to five redirects.
 * @param {string} url
 * @param {number} [timeoutMs]
 */
async function requestStream(url, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  let current = url
  for (let hop = 0; hop <= 5; hop += 1) {
    const target = new URL(current)
    if (!/^https?:$/.test(target.protocol)) throw coded('download_failed', 'Unsupported URL protocol: ' + target.protocol)
    const opened = await openRequest(target, timeoutMs)
    const response = await new Promise((resolvePromise, reject) => {
      const request = opened.request()
      request.setTimeout(timeoutMs, () => {
        request.destroy(coded('download_failed', 'Download timed out after ' + Math.round(timeoutMs / 1000) + 's: ' + current))
      })
      request.once('error', (error) => reject(coded('download_failed', 'Download failed: ' + error.message + ' (if GitHub is unreachable, set HTTPS_PROXY and retry)')))
      request.once('response', (incoming) => resolvePromise(incoming))
      request.end()
    })
    const location = response.headers.location
    if (response.statusCode >= 300 && response.statusCode < 400 && location) {
      response.resume()
      current = new URL(location, current).toString()
      continue
    }
    if (response.statusCode !== 200) {
      response.resume()
      throw coded('download_failed', 'Download failed with HTTP ' + response.statusCode + ': ' + current)
    }
    return response
  }
  throw coded('download_failed', 'Too many redirects while downloading ' + url)
}

/** Fetch a small JSON document (GitHub API). */
async function fetchJson(url, timeoutMs = 60 * 1000) {
  const stream = await requestStream(url, timeoutMs)
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.length
    if (size > 8 * 1024 * 1024) throw coded('download_failed', 'Response too large: ' + url)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw coded('download_failed', 'Malformed JSON from ' + url)
  }
}

/**
 * Download one URL to disk, verifying SHA-256 when expected.
 * The body never lands in memory: chunks flow through the hash into the file.
 * @returns {Promise<{path: string, sha256: string, bytes: number}>}
 */
export async function downloadFile(url, destination, expectedSha256, options = {}) {
  const timeoutMs = options.timeoutMs || DOWNLOAD_TIMEOUT_MS
  const stream = await requestStream(url, timeoutMs)
  await mkdir(dirname(destination), { recursive: true })
  const partial = destination + '.part'
  const hash = createHash('sha256')
  let bytes = 0
  async function* digesting(source) {
    for await (const chunk of source) {
      bytes += chunk.length
      hash.update(chunk)
      yield chunk
    }
  }
  try {
    await pipeline(digesting(stream), createWriteStream(partial))
    const sha256 = hash.digest('hex')
    if (expectedSha256 && String(expectedSha256).toLowerCase() !== sha256) {
      await rm(partial, { force: true }).catch(() => {})
      throw coded('checksum_mismatch', 'SHA-256 mismatch for ' + basename(destination) + ': expected ' + expectedSha256 + ', got ' + sha256)
    }
    await rm(destination, { force: true }).catch(() => {})
    await rename(partial, destination)
    return { path: destination, sha256, bytes }
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {})
    if (error && error.code && error.code !== 'download_failed') throw error
    throw error && error.code ? error : coded('download_failed', 'Download failed: ' + (error && error.message ? error.message : String(error)))
  }
}

// ---------------------------------------------------------------- extract --

/**
 * Extract a zip archive without depending on a third-party npm module.
 * Windows 10 1803+ ships bsdtar (supports zip); PowerShell Expand-Archive is
 * the fallback for machines where tar is unavailable or broken.
 * @param {string} archive
 * @param {string} destination
 * @param {{exec?: Function}} [options]
 */
export async function extractArchive(archive, destination, options = {}) {
  const exec = options.exec || defaultExec
  await mkdir(destination, { recursive: true })
  let tarError = null
  try {
    await exec('tar', ['-xf', archive, '-C', destination], { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    tarError = error
  }
  if (tarError === null) return { ok: true, tool: 'tar' }
  const escapedArchive = String(archive).replace(/'/g, "''")
  const escapedDestination = String(destination).replace(/'/g, "''")
  const script = "Expand-Archive -LiteralPath '" + escapedArchive + "' -DestinationPath '" + escapedDestination + "' -Force"
  try {
    await exec(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: EXTRACT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return { ok: true, tool: 'expand-archive' }
  } catch (error) {
    const detail = clip(String((error && (error.stderr || error.message)) || ''), 512)
    throw coded('install_failed', 'Could not extract ' + basename(archive) + ': tar and Expand-Archive both failed. ' + detail)
  }
}

/** Recursively copy a directory tree (no symlink following). */
async function copyTree(source, destination) {
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true, force: true, dereference: false, errorOnExist: false })
}

/** First directory inside a folder, or null when the folder holds several entries. */
async function soleEntry(directory) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }
  const usable = entries.filter((entry) => entry.isDirectory())
  return usable.length === 1 ? join(directory, usable[0].name) : null
}

/** Find a file by name at any depth below a directory (bounded depth). */
async function findDeep(root, name, depth = 4) {
  if (depth < 0) return null
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return join(root, entry.name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findDeep(join(root, entry.name), name, depth - 1)
    if (found) return found
  }
  return null
}

/** Directory that should become the managed root after stripRoot. */
async function extractionRoot(staging, stripRoot) {
  if (!stripRoot) return staging
  const single = await soleEntry(staging)
  return single || staging
}

// ----------------------------------------------------------------- install --

/** GitHub latest-release lookup for install.kind === 'github-latest'. */
async function resolveGithubLatest(install, options) {
  const repo = install.repo
  if (!repo) throw coded('bad_request', 'github-latest install is missing a repo')
  const release = await fetchJson('https://api.github.com/repos/' + repo + '/releases/latest', 60 * 1000).catch((error) => {
    if (options && options.latest) return options.latest
    throw error
  })
  const tag = String(release.tag_name || release.name || '').replace(/^v/i, '')
  if (!tag) throw coded('download_failed', 'GitHub release for ' + repo + ' has no tag')
  const assetName = install.asset ? String(install.asset).replace(/\{ver\}/g, tag) : null
  if (!assetName) throw coded('bad_request', 'github-latest install is missing an asset template')
  const asset = asArray(release.assets).find((candidate) => candidate && candidate.name === assetName)
  if (!asset || !asset.browser_download_url) {
    throw coded('download_failed', 'Release ' + tag + ' of ' + repo + ' has no asset named ' + assetName)
  }
  return { version: tag, url: asset.browser_download_url }
}

/** Install the apktool jar shipped by github-latest and generate a launcher. */
async function writeApktoolWrapper(root, jarPath, exec) {
  const directory = join(root, 'apktool')
  await mkdir(directory, { recursive: true })
  const wrapperPath = join(directory, 'apktool.cmd')
  const text = apktoolWrapperText(basename(jarPath))
  await writeFile(wrapperPath, text, 'utf8')
  return wrapperPath
}

/**
 * Batch launcher for apktool: prefers %JAVA_HOME%\bin\java.exe, falls back to
 * java.exe on PATH, and resolves the jar relative to the launcher so the
 * engine directory can move. Shared with installEngine and the doctor probe.
 */
export function apktoolWrapperText(jarName) {
  const lines = [
    '@echo off',
    'setlocal',
    'set "JAVA_EXE="',
    'if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" set "JAVA_EXE=%JAVA_HOME%\bin\java.exe"',
    'if not defined JAVA_EXE for %%J in (java.exe) do set "JAVA_EXE=%%~$PATH:J"',
    'if not defined JAVA_EXE (',
    '  echo rea-powerpack: java.exe not found; set JAVA_HOME or install a JDK 1>&2',
    '  exit /b 1',
    ')',
    '"%JAVA_EXE%" -jar "%~dp0' + jarName + '" %*',
  ]
  return lines.join('\r\n') + '\r\n'
}

/** Managed Python interpreter: an installed python engine, else the system PATH. */
async function resolveManagedPython(home, settings) {
  const manifest = await readManifest(home)
  const spec = byId('python')
  if (spec) {
    const record = recordFor(manifest, 'python')
    const resolved = locateEngine(spec, engineRoot(home, settings), record)
    if (resolved) {
      const directory = isDir(resolved) ? resolved : dirname(resolved)
      const executable = isDir(resolved) ? join(resolved, 'python.exe') : resolved
      if (isFile(executable)) return { path: executable, dir: directory }
      const scripts = join(directory, 'Scripts')
      const nested = join(directory, 'python.exe')
      if (isFile(nested)) return { path: nested, dir: directory }
      if (isDir(scripts)) return { path: nested, dir: directory }
    }
  }
  const found = findOnPath('python.exe') || findOnPath('python')
  if (found) return { path: found, dir: dirname(found) }
  throw coded('requires_dependency', 'Python is required for this engine; install the python engine first.')
}

/**
 * Install one engine. Downloads go to a temporary staging directory first so a
 * failed install never leaves a half-populated engine root.
 * @param {string} home
 * @param {object} settings
 * @param {string} id
 * @param {(level: string, event: string, detail?: unknown) => Promise<void>|void} [log]
 * @param {{exec?: Function, onProgress?: Function, latest?: object}} [options]
 */
export async function installEngine(home, settings, id, log, options = {}) {
  const spec = byId(id)
  if (!spec) throw coded('unknown_engine', 'Unknown engine: ' + id)
  if (spec.hostUnsupported === process.platform) throw coded('unsupported_host', spec.name + ' is not supported on Windows.')
  const install = spec.install
  if (!install) throw coded('bad_request', 'Engine ' + id + ' has no automated installer; install it manually.')
  const root = engineRoot(home, settings)
  await mkdir(root, { recursive: true })
  const exec = options.exec || defaultExec
  const say = typeof log === 'function' ? log : async () => {}
  const notify = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const manifest = await readManifest(home)
  for (const dependency of asArray(spec.requires)) {
    const record = recordFor(manifest, dependency)
    const dependencySpec = byId(dependency)
    const present = record && record.verified ? true : Boolean(dependencySpec && locateEngine(dependencySpec, root, record))
    if (!present) throw coded('requires_dependency', spec.name + ' requires ' + dependency + ', which is not installed.')
  }
  const staging = await mkdtemp(join(tmpdir(), 'rea-powerpack-'))
  const installedAt = new Date().toISOString()
  const baseRecord = { id: spec.id, name: spec.name, tier: spec.tier, version: null, path: null, envVar: spec.envVar || null, pathPrepend: spec.pathPrepend === true, sha256: null, verified: false, rawVersionOutput: null, installedAt, source: install.kind }
  let record = null
  try {
    if (install.kind === 'zip') {
      const archive = join(staging, 'download.zip')
      await notify('download', spec, install.url)
      const downloaded = await downloadFile(install.url, archive, install.sha256, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
      await say('info', 'engine.download', { id, bytes: downloaded.bytes })
      await notify('extract', spec, archive)
      const unpacked = join(staging, 'unpacked')
      await extractArchive(archive, unpacked, { exec })
      const inner = await extractionRoot(unpacked, install.stripRoot !== false)
      const destination = join(root, install.dest || spec.id)
      await copyTree(inner, destination)
      record = { ...baseRecord, path: install.binary ? join(destination, install.binary) : destination, sha256: downloaded.sha256, version: install.version || null }
    } else if (install.kind === 'file') {
      const destination = join(root, install.dest || basename(String(install.url)))
      await notify('download', spec, install.url)
      const downloaded = await downloadFile(install.url, destination, install.sha256, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
      await say('info', 'engine.download', { id, bytes: downloaded.bytes })
      record = { ...baseRecord, path: destination, sha256: downloaded.sha256, version: install.version || null }
    } else if (install.kind === 'github-latest') {
      await notify('resolve', spec, install.repo)
      const release = await resolveGithubLatest(install, options)
      const destination = join(root, install.dest || spec.id)
      await mkdir(dirname(destination), { recursive: true })
      await notify('download', spec, release.url)
      const downloaded = await downloadFile(release.url, destination, install.sha256, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
      await say('info', 'engine.download', { id, bytes: downloaded.bytes, version: release.version })
      const launcher = install.post === 'apktool-wrapper' ? await writeApktoolWrapper(root, destination, exec) : destination
      record = { ...baseRecord, path: launcher, sha256: downloaded.sha256, version: release.version }
    } else {
      record = await installThroughPackageManager(spec, install, home, settings, root, exec, notify, baseRecord)
    }
    const probed = await runProbe(spec, record.path, exec)
    record.verified = probed.ok
    record.version = record.version || probed.version || null
    record.rawVersionOutput = probed.output || null
    const written = await writeManifest(home, upsertRecord(manifest, record))
    if (!probed.ok) {
      throw coded('install_failed', spec.name + ' installed but its probe failed (' + (probed.reason || 'unknown') + '). ' + (probed.output ? clip(probed.output, 400) : ''))
    }
    return { ok: true, engine: engineStatus({ spec, record, status: 'ok', path: record.path, version: record.version, root }, process.platform), manifest: written }
  } catch (error) {
    await say('warn', 'engine.install.failed', { id, code: error && error.code ? error.code : 'install_failed', message: error && error.message ? error.message : String(error) })
    if (error && error.code === 'install_failed' && record && record.path) {
      await writeManifest(home, upsertRecord(manifest, record)).catch(() => {})
    }
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** winget / pip installers: they mutate machine state instead of the engine root. */
async function installThroughPackageManager(spec, install, home, settings, root, exec, notify, baseRecord) {
  if (install.kind === 'winget') {
    if (!install.wingetId) throw coded('bad_request', 'winget install is missing a wingetId')
    await notify('install', spec, install.wingetId)
    await exec('winget', ['install', '--id', install.wingetId, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], { timeout: PACKAGE_INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    const located = locateEngine(spec, root, null)
    if (!located) throw coded('install_failed', 'winget reported success but ' + spec.name + ' could not be located. Restart DSH so it picks up the updated PATH, then verify again.')
    return { ...baseRecord, path: located }
  }
  const python = await resolveManagedPython(home, settings)
  await notify('install', spec, install.package)
  const args = ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', '--no-input']
  for (const extra of asArray(install.pipArgs)) args.push(String(extra))
  args.push(String(install.package))
  await exec(python.path, args, { timeout: PACKAGE_INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  const scriptName = install.pipScript || (spec.probe && spec.probe.exe) || spec.id
  const scriptPath = join(python.dir, 'Scripts', scriptName)
  const path = isFile(scriptPath) ? scriptPath : locateEngine(spec, root, null)
  if (!path) throw coded('install_failed', 'pip reported success but ' + spec.name + ' could not be located under ' + python.dir)
  return { ...baseRecord, path }
}

/** Remove an engine installed under the engine root. External installs are only unregistered. */
export async function uninstallEngine(home, id, options = {}) {
  const spec = byId(id)
  if (!spec) throw coded('unknown_engine', 'Unknown engine: ' + id)
  const manifest = await readManifest(home)
  const record = recordFor(manifest, id)
  const root = manifest.root
  const removed = []
  if (record && record.path) {
    if (!isUnder(record.path, root)) {
      throw coded('bad_request', spec.name + ' was not installed by rea-powerpack; nothing was deleted. Remove it manually if you want it gone.')
    }
    const directory = (spec.install && spec.install.kind === 'zip') ? dirname(record.path) : record.path
    const target = isUnder(directory, root) ? directory : record.path
    if (isUnder(target, root)) {
      await rm(target, { recursive: true, force: true })
      removed.push(target)
    }
    if (spec.install && spec.install.dest) {
      const shared = join(root, spec.install.dest)
      if (isUnder(shared, root) && isDir(shared) && !removed.includes(shared)) {
        const onlyLeftovers = await readdir(shared).then((entries) => entries.length === 0).catch(() => false)
        if (onlyLeftovers) {
          await rm(shared, { recursive: true, force: true })
          removed.push(shared)
        }
      }
    }
  }
  const written = await writeManifest(home, dropRecord(manifest, id))
  return { ok: true, removed, manifest: written }
}

/** Register an engine the user already installed elsewhere. */
export async function importEngine(home, settings, payload, options = {}) {
  const requested = payload && typeof payload.id === 'string' ? payload.id : null
  const rawPath = payload && typeof payload.path === 'string' ? expandEnvPath(payload.path.trim()) : null
  if (!rawPath) throw coded('bad_request', 'import requires a path')
  if (!isAbsolute(rawPath)) throw coded('bad_request', 'import path must be absolute: ' + rawPath)
  if (!isFile(rawPath) && !isDir(rawPath)) throw coded('no_engine', 'Path does not exist: ' + rawPath)
  const exec = options.exec || defaultExec
  const manifest = await readManifest(home)
  let spec = requested ? byId(requested) : null
  if (requested && !spec) throw coded('unknown_engine', 'Unknown engine: ' + requested)
  if (!spec) {
    const matches = forPlatform(process.platform, process.env).filter((candidate) => {
      if (candidate.hostUnsupported === process.platform) return false
      if (candidate.envKind === 'dir' && isDir(rawPath)) return true
      const probe = candidate.probe && candidate.probe.exe
      if (probe && basename(rawPath).toLowerCase() === basename(probe).toLowerCase()) return true
      return false
    })
    if (matches.length === 0) throw coded('no_engine', 'No catalog engine matches ' + basename(rawPath) + '; pass an explicit id.')
    if (matches.length > 1) throw coded('bad_request', 'Ambiguous import path; pass an explicit id. Candidates: ' + matches.map((candidate) => candidate.id).join(', '))
    spec = matches[0]
  }
  const record = { id: spec.id, name: spec.name, tier: spec.tier, version: null, path: rawPath, envVar: spec.envVar || null, pathPrepend: spec.pathPrepend === true, sha256: null, verified: false, rawVersionOutput: null, installedAt: new Date().toISOString(), source: 'import' }
  if (spec.probe) {
    const probed = await runProbe(spec, rawPath, exec)
    record.verified = probed.ok
    record.version = probed.version || null
    record.rawVersionOutput = probed.output || null
  } else {
    record.verified = isFile(rawPath) || isDir(rawPath)
  }
  const written = await writeManifest(home, upsertRecord(manifest, record))
  return { ok: true, engine: engineStatus({ spec, record, status: record.verified ? 'ok' : 'broken', path: rawPath, version: record.version, root: manifest.root }, process.platform), manifest: written }
}

// ------------------------------------------------------------ env composer --

/**
 * Compose the REA_* environment the MCP server should see.
 * User-set variables always win; they are reported through
 * env.REA_POWERPACK_OVERRIDES instead of being overwritten.
 * @param {string} home
 * @param {object} settings
 * @returns {Promise<{env: Record<string, string>, pathPrepend: string[], missing: string[], warnings: string[]}>}
 */
export async function composeEnv(home, settings) {
  const manifest = await readManifest(home)
  const root = engineRoot(home, settings)
  const env = {}
  const overrides = []
  const pathPrepend = []
  const warnings = []
  for (const record of manifest.engines) {
    const spec = byId(record.id)
    if (record.extraEnv && typeof record.extraEnv === 'object') {
      for (const [key, value] of Object.entries(record.extraEnv)) {
        if (typeof value !== 'string') continue
        if (typeof process.env[key] === 'string' && process.env[key] !== '') continue
        env[key] = value
      }
    }
    if (!record.verified) continue
    const specForRecord = spec || { id: record.id, envKind: null, pathPrepend: record.pathPrepend, envVar: record.envVar }
    if (record.envVar) {
      const value = envPathFor(specForRecord, record.path || null)
      if (value) {
        const existing = process.env[record.envVar]
        if (typeof existing === 'string' && existing.trim() !== '') {
          overrides.push(record.envVar)
        } else {
          env[record.envVar] = value
        }
      } else {
        warnings.push(record.id + ' is verified but has no resolvable path; skipping ' + record.envVar)
      }
    }
    if (record.pathPrepend && record.path) {
      const directory = isDir(record.path) ? record.path : dirname(record.path)
      if (!pathPrepend.some((existing) => existing.toLowerCase() === directory.toLowerCase())) pathPrepend.push(directory)
    }
  }
  const verified = new Set(manifest.engines.filter((record) => record.verified).map((record) => record.id))
  const detected = new Set(manifest.engines.filter((record) => record.path).map((record) => record.id))
  const missing = forPlatform(process.platform, process.env)
    .filter((spec) => spec.tier <= 1 && !verified.has(spec.id) && !detected.has(spec.id))
    .map((spec) => spec.id)
  if (overrides.length > 0) env.REA_POWERPACK_OVERRIDES = Array.from(new Set(overrides)).join(',')
  return { env, pathPrepend, missing, warnings, root }
}

/** Public, non-executable snapshot of the catalog for /state and /report. */
export function catalogSnapshot(platform = process.platform) {
  return forPlatform(platform, process.env).map((spec) => ({
    id: spec.id,
    name: spec.name,
    tier: spec.tier,
    envVar: spec.envVar || null,
    envKind: spec.envKind || null,
    pathPrepend: spec.pathPrepend === true,
    install: spec.install ? { kind: spec.install.kind } : null,
    hostUnsupported: spec.hostUnsupported || null,
    docs: spec.docs || null,
    notes: spec.notes || null,
  }))
}

/** Number of catalog entries (used by tests and /report). */
export const CATALOG_SIZE = ENGINES.length
