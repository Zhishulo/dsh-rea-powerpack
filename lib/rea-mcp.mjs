#!/usr/bin/env node
/**
 * MCP launcher for dsh-rea-powerpack.
 *
 * The host MCP client row starts this file as
 *   node lib/rea-mcp.mjs <profileDir> mcp
 * and this file replaces its own process image with the pinned REA entry point
 * after composing the engine environment. It stays in the same process on
 * purpose: MCP needs single ownership of stdin/stdout.
 *
 * When the current Node is older than the range rea-agents declares in its
 * package.json engines.node, the launcher re-executes itself with a suitable
 * Node found on PATH so REA's own doctor stops reporting node as missing.
 * The re-executed child inherits stdio, so the JSON-RPC pipe stays intact.
 *
 * @see ARCHITECTURE.md §5 (lib/rea-mcp.mjs)
 */
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { composeEnv, powerpackHome, readSettings } from './engines.js'

const TRACE = process.env.REA_POWERPACK_TRACE === '1'
const REEXEC_ENV = 'REA_POWERPACK_EXEC'
const SELF_PATH = fileURLToPath(import.meta.url)
/** Used only when rea-agents/package.json cannot be read. */
const REA_MIN_NODE = '24.22.1'

/** Write one diagnostic line to stderr (stdout belongs to MCP). */
function warn(message) {
  process.stderr.write('rea-powerpack: ' + message + '\n')
}

/** Thrown by fail() so the top-level handler can flush stderr before exiting. */
class LauncherError extends Error {}

function fail(message) {
  // Do not call process.exit() here: on Windows the stderr pipe is written
  // asynchronously, so exiting immediately silently drops the message.
  throw new LauncherError(message)
}

// ------------------------------------------------------------- versions --

/** Parse a dotted version (1-3 components), or null when none is present. */
export function parseVersion(text) {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text === undefined || text === null ? '' : text))
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2] || 0)
  const patch = Number(match[3] || 0)
  return { major: major, minor: minor, patch: patch, text: major + '.' + minor + '.' + patch }
}

/** Compare two version strings; returns -1, 0 or 1. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

function matchComparator(version, token) {
  if (token === '' || token === '*' || token === 'x' || token === 'X') return true
  const parsed = /^(>=|<=|>|<|=|\^|~)?(.*)$/.exec(token)
  const operator = parsed ? parsed[1] || '' : ''
  const body = parsed ? parsed[2] : token
  const target = parseVersion(body)
  if (!target) return false
  const sign = compareVersions(version.text, target.text)
  switch (operator) {
    case '>':
      return sign > 0
    case '>=':
      return sign >= 0
    case '<':
      return sign < 0
    case '<=':
      return sign <= 0
    case '^':
      if (sign < 0) return false
      if (target.major > 0) return version.major === target.major
      if (target.minor > 0) return version.major === 0 && version.minor === target.minor
      return version.major === 0 && version.minor === 0 && version.patch === target.patch
    case '~':
      return sign >= 0 && version.major === target.major && version.minor === target.minor
    default:
      return sign === 0
  }
}

/** Does a version satisfy a semver range such as "^22.23.4 || ^24.22.1 || >=26.12.1"? */
export function satisfiesRange(version, range) {
  const current = parseVersion(version)
  if (!current) return false
  const clauses = String(range === undefined || range === null ? '' : range)
    .split('||')
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
  if (clauses.length === 0) return true
  return clauses.some((clause) =>
    clause
      .split(/\s+/)
      .filter((token) => token !== '')
      .every((token) => matchComparator(current, token)),
  )
}

/** Lowest version mentioned by a range, for user-facing messages. */
export function minimumRequired(range) {
  const tokens = String(range === undefined || range === null ? '' : range)
    .split('||')
    .join(' ')
    .split(/\s+/)
    .filter((token) => token !== '')
  let lowest = null
  for (const token of tokens) {
    const parsed = parseVersion(token)
    if (!parsed) continue
    if (lowest === null || compareVersions(parsed.text, lowest) < 0) lowest = parsed.text
  }
  return lowest
}

/**
 * Pick the first candidate whose Node version satisfies the requirement.
 * Candidates are { path, version } pairs; the return value is the candidate
 * itself or null. Pure so the selection policy is unit-testable.
 */
export function selectNode(candidates, required) {
  if (!Array.isArray(candidates)) return null
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const version = candidate.version || candidate.text || null
    if (!version) continue
    if (satisfiesRange(version, required)) return candidate
  }
  return null
}

// ------------------------------------------------------- node re-exec --

/** Read REA's own engines.node requirement; fall back to REA_MIN_NODE. */
export function readReaNodeRange(profileDir) {
  try {
    const require = createRequire(join(profileDir, 'package.json'))
    const manifestPath = require.resolve('rea-agents/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const range = manifest && manifest.engines ? manifest.engines.node : null
    if (typeof range === 'string' && range.trim() !== '') return range.trim()
  } catch {
    // fall through to the built-in floor
  }
  return '>=' + REA_MIN_NODE
}

function nodeVersionOf(execPath) {
  try {
    const output = execFileSync(execPath, ['-v'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const parsed = parseVersion(output)
    return parsed ? parsed.text : null
  } catch {
    return null
  }
}

function pathNodeNames() {
  if (process.platform === 'win32') return ['node.exe', 'node.cmd', 'node.bat', 'node']
  return ['node']
}

/**
 * Candidate Node executables: REA_POWERPACK_NODE first, then PATH order.
 * process.execPath is excluded on purpose - under the desktop host it is the
 * Electron binary (or a Node older than REA requires), never the fix.
 */
export function collectNodeCandidates(env, selfPath, execPath) {
  const environment = env && typeof env === 'object' ? env : {}
  const self = String(selfPath || '').toLowerCase()
  const own = String(execPath || '').toLowerCase()
  const list = []
  const seen = new Set()
  const push = (candidatePath) => {
    if (typeof candidatePath !== 'string' || candidatePath.trim() === '') return
    let absolute
    try {
      absolute = resolve(candidatePath.trim())
    } catch {
      return
    }
    const key = absolute.toLowerCase()
    if (key === self || key === own || seen.has(key)) return
    seen.add(key)
    try {
      if (!existsSync(absolute) || !statSync(absolute).isFile()) return
    } catch {
      return
    }
    const version = nodeVersionOf(absolute)
    if (!version) return
    list.push({ path: absolute, version: version })
  }
  push(environment.REA_POWERPACK_NODE)
  const pathValue = environment.PATH || environment.Path || ''
  const dirs = String(pathValue).split(delimiter).filter((dir) => dir !== '')
  const names = pathNodeNames()
  for (const dir of dirs) {
    for (const name of names) push(join(dir, name))
  }
  return list
}

/**
 * Decide how the launcher should proceed. Pure so the policy can be unit
 * tested without spawning anything:
 *   { action: 'continue', reason }  stay in this process
 *   { action: 'run', candidate }    hand over to candidate.path
 */
export function planReexec(environment, currentVersion, range, candidates) {
  const env = environment && typeof environment === 'object' ? environment : {}
  if (env[REEXEC_ENV] === '1') return { action: 'continue', reason: 'already-reexecuted' }
  const current = parseVersion(currentVersion)
  if (current && satisfiesRange(current.text, range)) return { action: 'continue', reason: 'satisfied' }
  const chosen = selectNode(candidates, range)
  if (!chosen) {
    return {
      action: 'continue',
      reason: 'no-candidate',
      warn: 'current node ' + currentVersion + ' is below REA requirement ' + range + '; continuing anyway',
    }
  }
  return { action: 'run', candidate: chosen }
}

/**
 * Re-execute this launcher with a Node that satisfies REA's requirement.
 * Returns false when no re-exec is needed or possible; otherwise it hands the
 * process over to the child and never returns.
 */
async function maybeReexec(profileDir) {
  const range = readReaNodeRange(profileDir)
  const candidates = collectNodeCandidates(process.env, SELF_PATH, process.execPath)
  const plan = planReexec(process.env, process.version, range, candidates)
  if (plan.action === 'continue') {
    if (plan.warn) warn(plan.warn)
    return false
  }
  const chosen = plan.candidate

  warn('node ' + process.version + ' is below REA requirement ' + range + '; re-executing with ' + chosen.path + ' (' + chosen.version + ')')
  const argv = process.argv.slice(1)
  const environment = { ...process.env }
  environment[REEXEC_ENV] = '1'
  await new Promise((resolvePromise) => {
    const child = spawn(chosen.path, [SELF_PATH, ...argv.slice(1)], {
      stdio: 'inherit',
      env: environment,
      windowsHide: true,
    })
    child.on('error', (error) => {
      warn('re-exec with ' + chosen.path + ' failed (' + (error && error.message ? error.message : String(error)) + '); continuing on ' + process.version)
      resolvePromise(false)
    })
    child.on('exit', (code, signal) => {
      process.exit(code === null || code === undefined ? (signal ? 1 : 0) : code)
    })
  })
  return false
}

// ------------------------------------------------------------ main flow --

function resolveReaEntry(profileDir) {
  const require = createRequire(join(profileDir, 'package.json'))
  let entry = null
  try {
    entry = require.resolve('rea-agents/scripts/rea.mjs')
  } catch {
    entry = null
  }
  if (!entry) {
    fail(
      'rea-agents is not installed in ' + profileDir +
      '; open Settings -> REA Powerpack -> Install',
    )
  }
  return entry
}

/**
 * Compose the engine environment, but never block startup on it: a broken
 * engines.json must only degrade individual REA tools, not the MCP server.
 */
async function applyEngineEnv(home) {
  try {
    const settings = await readSettings(home)
    const composed = await composeEnv(home, settings)
    if (composed && composed.env && typeof composed.env === 'object') {
      for (const key of Object.keys(composed.env)) {
        const value = composed.env[key]
        if (typeof value !== 'string') continue
        if (key === 'REA_POWERPACK_OVERRIDES') {
          process.env.REA_POWERPACK_OVERRIDES = value
          continue
        }
        process.env[key] = value
      }
    }
    if (composed && Array.isArray(composed.pathPrepend) && composed.pathPrepend.length > 0) {
      const extra = composed.pathPrepend.filter((dir) => typeof dir === 'string' && dir !== '')
      if (extra.length > 0) {
        process.env.PATH = extra.join(delimiter) + delimiter + (process.env.PATH || '')
      }
    }
    if (composed && Array.isArray(composed.missing) && composed.missing.length > 0) {
      warn(
        'engine(s) not installed: ' + composed.missing.join(', ') +
        ' (matching REA tools will report provider_unavailable)',
      )
    }
    if (composed && Array.isArray(composed.warnings)) {
      for (const line of composed.warnings) warn(line)
    }
    if (TRACE) {
      const keys = Object.keys(process.env)
        .filter((key) => key.startsWith('REA_') || key === 'JAVA_HOME' || key === 'GHIDRA_INSTALL_DIR')
        .sort()
      warn('composed env keys: ' + keys.join(', '))
    }
  } catch (error) {
    warn(
      'engine environment unavailable (' +
      (error && error.message ? error.message : String(error)) +
      '); continuing without it',
    )
  }
}

/**
 * Compare two paths as the same file, tolerating symlinks/junctions.
 *
 * The host launches this file through the profile's `node_modules` entry, which
 * is a junction to the unpacked plugin directory, while `import.meta.url` has
 * already been resolved to the real path by Node's ESM loader. Comparing the
 * raw strings therefore fails and the launcher would silently do nothing.
 */
function samePath(a, b) {
  const left = resolve(a)
  const right = resolve(b)
  if (left.toLowerCase() === right.toLowerCase()) return true
  try {
    // realpathSync echoes the caller's casing for an already-real path, so the
    // two results must be compared case-insensitively on Windows.
    return realpathSync(left).toLowerCase() === realpathSync(right).toLowerCase()
  } catch {
    return false
  }
}

/** True only when this file is the process entry point, not an import. */
export function isEntryPoint(argv, selfPath) {
  const entry = Array.isArray(argv) ? argv[1] : null
  if (typeof entry !== 'string' || entry === '') return false
  if (typeof selfPath !== 'string' || selfPath === '') return false
  try {
    return samePath(entry, selfPath)
  } catch {
    return false
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const profileDir = argv[0]
  if (!profileDir || profileDir === '') {
    fail('missing profile directory; usage: rea-mcp.mjs <profileDir> mcp')
  }

  // Take over with a suitable Node first: the host starts this file with
  // process.execPath, which may be an Electron runtime older than REA wants.
  await maybeReexec(profileDir)

  const entry = resolveReaEntry(profileDir)
  const home = powerpackHome(profileDir)
  await applyEngineEnv(home)

  // Hand stdio to REA in this same process.
  process.argv = [process.argv[0], entry, ...argv.slice(1)]
  await import(pathToFileURL(entry).href)
}

if (isEntryPoint(process.argv, SELF_PATH)) {
  try {
    await main()
  } catch (error) {
    if (!(error instanceof LauncherError)) throw error
    warn(error.message)
    process.exitCode = 1
  }
}
