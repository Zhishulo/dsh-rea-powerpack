#!/usr/bin/env node
/**
 * Cross-cutting acceptance gate for dsh-rea-powerpack.
 *
 * This is the Lead's independent check: it does not trust the plugin's own
 * reporting. It re-derives, from the outside, the four things that must be true
 * before the plugin may be installed into a profile:
 *
 *   1. package.json declares the DSH bundle + client halves and a valid name;
 *   2. every lib file parses (node --check) — catches half-written files;
 *   3. cordis.patch.yml carries the two loader rows, the launcher argv reaches
 *      the profile, and the js expression actually evaluates to an existing file;
 *   4. the launcher, spawned with NO extra environment, still brings REA up with
 *      229 tools and no affordable provider gap (engine env synthesis works).
 *
 * Usage:
 *   node dev/acceptance.mjs [--repo <dir>] [--profile <dir>] [--engines <file>]
 *                           [--skip-mcp] [--save-baseline]
 *
 * Exit: 0 all green · 1 hard failure · 2 only warnings.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { locateRepo } from './_layout.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes('--' + name)

const REPO = resolve(arg('repo', locateRepo(HERE)))
const PROFILE = resolve(arg('profile', join(homedir(), '.dsh', 'profiles', 'desktop')))
const ENGINES_FILE = resolve(
  arg('engines', process.env.REA_POWERPACK_HOME
    ? join(process.env.REA_POWERPACK_HOME, 'engines.json')
    : join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'rea-powerpack', 'engines.json')),
)

/** Collected results: {level:'pass'|'warn'|'fail', name, detail}. */
const results = []
const pass = (name, detail = '') => results.push({ level: 'pass', name, detail })
const warn = (name, detail = '') => results.push({ level: 'warn', name, detail })
const fail = (name, detail = '') => results.push({ level: 'fail', name, detail })

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ------------------------------------------------------------ 1. package.json --
const pkg = readJson(join(REPO, 'package.json'))
if (!pkg) {
  fail('package.json', 'missing or unparsable at ' + REPO)
} else {
  pkg.name === 'dsh-rea-powerpack' ? pass('pkg.name', pkg.name) : warn('pkg.name', 'expected dsh-rea-powerpack, got ' + pkg.name)
  pkg.dsh?.bundle?.patch ? pass('pkg.dsh.bundle.patch', String(pkg.dsh.bundle.patch)) : fail('pkg.dsh.bundle.patch', 'absent — the bundle layer would never load')
  pkg.dsh?.client ? pass('pkg.dsh.client', JSON.stringify(pkg.dsh.client).slice(0, 80)) : fail('pkg.dsh.client', 'absent — no Settings card')
  if (pkg.dsh?.client) {
    const inject = Array.isArray(pkg.dsh.client.inject) ? pkg.dsh.client.inject : []
    const need = ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-locale']
    const missing = need.filter((name) => !inject.includes(name))
    missing.length === 0
      ? pass('pkg.dsh.client.inject', inject.join(', '))
      : warn('pkg.dsh.client.inject', 'missing ' + missing.join(', ') + ' — the Settings tab may never load')
  }
  for (const file of ['lib/index.js', 'lib/catalog.js', 'lib/engines.js', 'lib/pin.js', 'lib/reload.js', 'lib/rea-mcp.mjs', 'lib/client.js', 'cordis.patch.yml'])
    existsSync(join(REPO, file)) ? pass('file ' + file) : fail('file ' + file, 'missing')
}

// ---------------------------------------------------------- 2. syntax checks --
const syntaxTargets = []
for (const sub of ['lib', 'test']) {
  const dir = join(REPO, sub)
  if (!existsSync(dir)) continue
  for (const name of execFileSync('cmd', ['/c', 'dir', '/b', dir], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean))
    if (/\.(mjs|js|cjs)$/.test(name)) syntaxTargets.push(join(dir, name))
}
for (const file of syntaxTargets) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    pass('syntax ' + file.slice(REPO.length + 1))
  } catch (error) {
    fail('syntax ' + file.slice(REPO.length + 1), String(error.stderr || error.message).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200))
  }
}

// ------------------------------------------------------- 3. cordis.patch.yml --
const patchPath = join(REPO, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const text = readFileSync(patchPath, 'utf8')
  const rowId = arg('row', 'rea-powerpack-mcp')
  text.includes('id: ' + rowId) ? pass('patch mcp row', rowId) : fail('patch mcp row', 'no \'' + rowId + '\' row')
  text.includes('@deepseek-ai/dsh-mcp-client') ? pass('patch mcp client row') : fail('patch mcp client row', 'mcp-client row missing')
  text.includes('process.execPath') ? pass('patch command process.execPath') : fail('patch command', 'must run the harness executable')
  text.includes('ELECTRON_RUN_AS_NODE') ? pass('patch ELECTRON_RUN_AS_NODE') : warn('patch ELECTRON_RUN_AS_NODE', 'desktop builds need this to behave as node')
  text.includes('lib/rea-mcp.mjs') ? pass('patch launcher path') : fail('patch launcher path', 'launcher not referenced')
  // The js expression must yield an existing launcher when evaluated the way the
  // loader does it (new Function('ctx', 'with (ctx) { return eval(expr) }')).
  const m = text.match(/!!js\s+(?:"([^"]+)"|'([^']+)')/g) || []
  const exprs = m.map((raw) => raw.replace(/^!!js\s+["']|["']$/g, ''))
  const ctx = { dshHomePath: (...parts) => join(homedir(), '.dsh', ...parts) }
  let launcherResolved = null
  for (const expr of exprs) {
    try {
      const value = new Function('ctx', 'with (ctx) { return eval(' + JSON.stringify(expr) + ') }')(ctx)
      if (typeof value === 'string' && value.includes('rea-mcp.mjs')) launcherResolved = value
    } catch (error) {
      warn('patch js expression', String(error.message).slice(0, 120))
    }
  }
  if (launcherResolved) {
    // The row passes <profile> as argv[1]; the launcher itself must exist.
    existsSync(launcherResolved) ? pass('patch launcher resolves', launcherResolved) : fail('patch launcher resolves', 'expression yields a missing file: ' + launcherResolved)
  }
  // The host addresses rows by id: if lib/index.js looks up a different row id than the
  // patch inserts, /state reports "row missing" and /reload can never find it.
  const indexPath = join(REPO, 'lib', 'index.js')
  if (existsSync(indexPath)) {
    const source = readFileSync(indexPath, 'utf8')
    const literal = /const ROW_ID = '([^']+)'/.exec(source)
    if (literal) {
      literal[1] === rowId
        ? pass('patch row id matches index.js', literal[1])
        : fail('patch row id matches index.js', 'index.js ROW_ID=' + literal[1] + ' but patch inserts ' + rowId)
    } else {
      warn('patch row id matches index.js', 'ROW_ID is not a plain string literal; cannot cross-check')
    }
    // ctx.loader.entries() is a generator (cordis-plugin-loader EntryTree), so an
    // Array.isArray guard silently reports "row missing" for a row that is loaded
    // and makes /reload unable to ever fire.
    const iteratorGuard = /Array\.isArray\(entries\)\s*\?\s*entries\b/.test(source)
    const materialises = /Array\.from\(entries\)|\[\.\.\.entries\]/.test(source)
    if (iteratorGuard) fail('loader rows materialised', 'lib/index.js treats the loader.entries() iterator as an array; it is a generator')
    else if (!materialises) fail('loader rows materialised', 'lib/index.js never materialises loader.entries()')
    else pass('loader rows materialised')
  }
  // The launcher is started through the profile's node_modules junction while
  // import.meta.url is the realpath: a string-only entry guard makes it exit 0
  // without starting REA (which is exactly how the MCP row went missing).
  const launcherFile = join(REPO, 'lib', 'rea-mcp.mjs')
  if (existsSync(launcherFile)) {
    const launcherSource = readFileSync(launcherFile, 'utf8')
    const normalises = /realpathSync\(/.test(launcherSource)
    if (normalises) pass('launcher entry guard normalises links')
    else fail('launcher entry guard normalises links', 'isEntryPoint compares strings only; a junction launch silently does nothing')
  }
}

// -------------------------------------------------------------- 4. engines.json --
const manifest = existsSync(ENGINES_FILE) ? readJson(ENGINES_FILE) : null
if (!manifest) {
  warn('engines.json', 'absent at ' + ENGINES_FILE + ' — engine env synthesis will be empty')
} else {
  manifest.version === 1 ? pass('engines.json version') : warn('engines.json version', 'got ' + manifest.version)
  const records = Array.isArray(manifest.engines) ? manifest.engines : []
  records.length ? pass('engines.json records', String(records.length)) : fail('engines.json records', 'empty')
  if (manifest.root) { existsSync(manifest.root) ? pass('engines.json root', manifest.root) : fail('engines.json root', 'missing directory: ' + manifest.root) }
  // The manifest format carries no envKind field (engines.js normalizes it away);
  // the direction of each variable is fixed by the catalog contract instead.
  const DIR_VARS = new Set(['JAVA_HOME', 'GHIDRA_INSTALL_DIR', 'REA_WABT_BIN_DIRECTORY'])
  for (const record of records) {
    const label = 'engine ' + record.id
    if (!record.path || !existsSync(record.path)) { fail(label, 'path missing: ' + record.path); continue }
    const isDirRecord = statSync(record.path).isDirectory()
    if (record.envVar) {
      const expected = record.envKind ? record.envKind : (DIR_VARS.has(record.envVar) ? 'dir' : 'file')
      if (expected === 'dir' ? !isDirRecord : isDirRecord) warn(label, record.envVar + ' expects a ' + expected + ' but the path is a ' + (isDirRecord ? 'directory' : 'file'))
    } else if (!record.pathPrepend) {
      warn(label, 'no envVar and no pathPrepend — this engine is unreachable to REA')
    }
    record.verified ? pass(label, record.version + ' · ' + record.envVar) : warn(label, 'not verified')
  }
}

// --------------------------------------------------------------- 5. MCP handshake --
const runMcp = (launcher) => new Promise((done) => {
  if (!existsSync(launcher)) return done({ skipped: 'lib/rea-mcp.mjs missing' })
  const child = spawn(process.execPath, [join(HERE, 'verify-mcp.mjs'), '--launcher', launcher, '--profile', PROFILE, '--list-tools'], {
    cwd: REPO,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  child.on('error', (e) => done({ error: String(e.message) }))
  child.on('close', (code) => {
    let parsed = null
    const start = out.indexOf('{')
    if (start >= 0) { try { parsed = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1)) } catch {} }
    done({ code, parsed, err })
  })
})

let toolNames = null
const mcp = flag('skip-mcp') ? { skipped: '--skip-mcp' } : await runMcp(join(REPO, 'lib', 'rea-mcp.mjs'))
if (mcp.skipped) {
  warn('mcp handshake', 'skipped: ' + mcp.skipped)
} else if (mcp.error) {
  fail('mcp handshake', mcp.error)
} else {
  const avail = mcp.parsed?.availability || {}
  const realGaps = (avail.unavailable || []).filter((g) => (g.reason === 'provider_unavailable' || g.reason === 'provider_missing') && g.surface !== 'jeb-provider')
  mcp.code === 0 ? pass('mcp handshake', 'exit 0 · ' + mcp.parsed.toolCount + ' tools · ' + avail.available + '/' + avail.groups + ' groups') : fail('mcp handshake', 'exit ' + mcp.code + ' · ' + String(mcp.err || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300))
  mcp.parsed?.toolCount >= 229 ? pass('mcp tool count', String(mcp.parsed.toolCount)) : warn('mcp tool count', String(mcp.parsed?.toolCount))
  realGaps.length ? fail('mcp provider gaps', realGaps.map((g) => g.surface + '(' + g.reason + ')').join(', ')) : pass('mcp provider gaps', 'none afford' + 'able')
  if (mcp.parsed?.tools) toolNames = mcp.parsed.tools
}

// Host path handshake: the loader starts the launcher through the profile's
// node_modules junction (a link:) rather than the repo path. That is the exact
// shape that used to exit 0 silently, so it gets its own end-to-end check.
if (!flag('skip-mcp')) {
  const installedLauncher = join(PROFILE, 'node_modules', 'dsh-rea-powerpack', 'lib', 'rea-mcp.mjs')
  if (!existsSync(installedLauncher)) {
    warn('mcp handshake via profile junction', 'dsh-rea-powerpack is not installed in ' + PROFILE)
  } else {
    const viaProfile = await runMcp(installedLauncher)
    const viaTools = viaProfile.parsed?.toolCount || 0
    viaProfile.code === 0 && viaTools >= 229
      ? pass('mcp handshake via profile junction', viaTools + ' tools')
      : fail('mcp handshake via profile junction', 'exit ' + viaProfile.code + ' · ' + String(viaProfile.err || '').trim().split('\n').slice(-2).join(' | ').slice(0, 240))
  }
}

// Baseline drift: a new REA release may add tools; a *lost* tool is a regression.
const baselineFile = join(HERE, 'tool-baseline.json')
if (toolNames && flag('save-baseline')) {
  writeFileSync(baselineFile, JSON.stringify(toolNames.sort(), null, 0) + '\n')
  pass('baseline saved', String(toolNames.length))
} else if (toolNames && existsSync(baselineFile)) {
  const base = new Set(readJson(baselineFile) || [])
  const now = new Set(toolNames)
  const lost = [...base].filter((n) => !now.has(n))
  const added = [...now].filter((n) => !base.has(n))
  lost.length ? fail('tool baseline', 'lost ' + lost.length + ': ' + lost.slice(0, 6).join(',')) : pass('tool baseline', 'kept all ' + base.size + ' · added ' + added.length)
}

// -------------------------------------------------------------------- report --
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n)
console.log('\ndsh-rea-powerpack acceptance — ' + REPO)
console.log('  profile: ' + PROFILE)
console.log('  engines: ' + ENGINES_FILE + '\n')
for (const r of results) {
  const mark = r.level === 'pass' ? 'PASS' : r.level === 'warn' ? 'WARN' : 'FAIL'
  console.log(mark + '  ' + pad(r.name, 42) + (r.detail || ''))
}
const failures = results.filter((r) => r.level === 'fail')
const warnings = results.filter((r) => r.level === 'warn')
console.log('\n' + results.length + ' checks · ' + (results.length - failures.length - warnings.length) + ' pass · ' + warnings.length + ' warn · ' + failures.length + ' fail')
if (failures.length) process.exit(1)
if (warnings.length) process.exit(2)
process.exit(0)