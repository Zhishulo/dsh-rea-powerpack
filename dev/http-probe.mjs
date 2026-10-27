#!/usr/bin/env node
// Fake-ctx probe for the dsh-rea-powerpack host half (lib/index.js).
//
// It imports the plugin exactly the way the DSH loader does — a module whose
// exports carry { name, inject, apply } — but hands it a stub context instead of
// a live harness, then drives the HTTP handler with synthetic node req/res
// objects. Nothing here talks to the real profile: REA_POWERPACK_HOME is
// redirected to a scratch directory so even a write route cannot touch the
// user's engine tree.
//
// Usage: node dev/http-probe.mjs [--doctor] [--repo <dir>]
// Exit: 0 all checks pass · 1 a check failed · 3 usage/plugin missing

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { locateRepo } from './_layout.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (n) => argv.includes('--' + n)
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const repo = resolve(opt('repo', locateRepo(here)))
const scratch = mkdtempSync(join(tmpdir(), 'rea-powerpack-probe-'))
process.env.REA_POWERPACK_HOME = scratch

const results = []
const record = (ok, name, detail) => {
  results.push({ ok, name, detail: detail === undefined ? '' : String(detail) })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined || detail === '' ? '' : '   ' + String(detail)))
}

const entry = join(repo, 'lib', 'index.js')
let mod
try {
  mod = await import(pathToFileURL(entry).href)
} catch (error) {
  if (error && (error.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(String(error.message)))) {
    console.log('SKIP: lib/index.js is not on disk yet (' + entry + ')')
    process.exit(3)
  }
  console.error('FAIL: lib/index.js threw while importing: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
}

record(mod.name === 'dsh-rea-powerpack', 'exports.name', mod.name)
record(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'exports.inject has webServer', JSON.stringify(mod.inject))
record(typeof mod.apply === 'function', 'exports.apply is a function')
const defaultExport = mod.default && typeof mod.default === 'object' ? mod.default : null
record(defaultExport !== null && defaultExport.apply === mod.apply, 'default export mirrors apply')

// A stub context: only the services a host half is allowed to touch.
const registered = []
const logs = []
const ctx = {
  webServer: {
    register(spec) {
      registered.push(spec)
      return () => {
        const i = registered.indexOf(spec)
        if (i >= 0) registered.splice(i, 1)
      }
    },
  },
  effect(fn, label) {
    const dispose = fn()
    logs.push('effect:' + (label === undefined ? '' : label))
    return typeof dispose === 'function' ? dispose : () => {}
  },
  loader: { entries: () => [] },
  logger: { info() {}, warn() {}, error() {} },
  get: () => undefined,
  profileContext: { profileDir: join(scratch, 'profile'), home: scratch },
  dshHomePath: (...parts) => join(scratch, ...parts),
}

try {
  mod.apply(ctx)
} catch (error) {
  record(false, 'apply(ctx) does not throw', error && error.message)
  process.exit(1)
}
record(registered.length >= 1, 'apply registers a webServer route', registered.length + ' registration(s)')
const mount = registered.find((spec) => spec && typeof spec.handler === 'function')
if (!mount) {
  record(false, 'route registration carries a handler')
  process.exit(1)
}
record(mount.kind === 'prefix', 'route kind is prefix', mount.kind)
record(String(mount.path).replace(/\/+$/, '') === '/rea-powerpack', 'route path is /rea-powerpack', mount.path)

const call = async (method, route, body, remoteAddress) => {
  const chunks = []
  const response = {
    statusCode: 0,
    headers: {},
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
    getHeader(k) { return this.headers[String(k).toLowerCase()] },
    writeHead(status, headers) { this.statusCode = status; if (headers) for (const [k, v] of Object.entries(headers)) this.setHeader(k, v) },
    write(chunk) { if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))) },
    end(chunk) {
      if (chunk !== undefined && typeof chunk !== 'function') chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      this.finished = true
    },
    finished: false,
  }
  const payload = body === undefined ? '' : JSON.stringify(body)
  const request = {
    method,
    url: mount.path + route,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
    socket: { remoteAddress: remoteAddress === undefined ? '127.0.0.1' : remoteAddress },
    on(event, handler) {
      if (event === 'data' && payload !== '') handler(Buffer.from(payload))
      if (event === 'end') handler()
      return request
    },
    async *[Symbol.asyncIterator]() { if (payload !== '') yield Buffer.from(payload) },
  }
  await mount.handler(request, response)
  const text = Buffer.concat(chunks).toString('utf8')
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: response.statusCode, headers: response.headers, text, json }
}

// ---- 1. loopback gate -------------------------------------------------------
const denied = await call('GET', '/state', undefined, '10.1.2.3')
record(denied.status === 403, 'non-loopback request is refused', 'status ' + denied.status)

// ---- 2. unknown route -------------------------------------------------------
const missing = await call('GET', '/definitely-not-a-route')
record(missing.status === 404, 'unknown route answers 404', 'status ' + missing.status)
record(missing.json !== null && missing.json.error && typeof missing.json.error.code === 'string', 'unknown route carries error.code', missing.json && missing.json.error ? missing.json.error.code : missing.text.slice(0, 80))

// ---- 3. GET /state ----------------------------------------------------------
const state = await call('GET', '/state')
record(state.status === 200, 'GET /state answers 200', 'status ' + state.status)
const s = state.json
record(s !== null && typeof s === 'object', 'GET /state answers JSON')
if (s && typeof s === 'object') {
  record(Array.isArray(s.engines), 'state.engines is an array', Array.isArray(s.engines) ? s.engines.length + ' row(s)' : typeof s.engines)
  record(s.rea !== null && typeof s.rea === 'object', 'state.rea is an object')
  record(s.settings !== null && typeof s.settings === 'object', 'state.settings is an object')
  record(s.mcp !== null && typeof s.mcp === 'object', 'state.mcp is an object')
  record(s.host !== null && typeof s.host === 'object', 'state.host is an object')
  record(typeof s.writable === 'boolean', 'state.writable is a boolean', s.writable)
  const allowed = new Set(['ok', 'external_ok', 'missing', 'broken', 'unsupported_host', 'requires_dependency', 'external_missing'])
  const bad = (s.engines || []).filter((row) => !allowed.has(row.status)).map((row) => row.id + ':' + row.status)
  record(bad.length === 0, 'engine.status vocabulary matches the client', bad.length ? bad.join(',') : 'all rows valid')
  const noId = (s.engines || []).filter((row) => typeof row.id !== 'string' || row.id === '')
  record(noId.length === 0, 'every engine row has an id')
}

// ---- 4. GET /report is markdown, not JSON -----------------------------------
const report = await call('GET', '/report')
record(report.status === 200, 'GET /report answers 200', 'status ' + report.status)
record(!/^\s*[\[{]/.test(report.text), 'GET /report is not a JSON document', report.text.slice(0, 60).replace(/\n/g, '\\n'))
record(String(report.headers['content-type'] || '').includes('text/markdown') || report.text.includes('#'), 'GET /report looks like markdown')

// ---- 5. POST /settings round-trip ------------------------------------------
const write = await call('POST', '/settings', { updatePolicy: 'manual' })
if (flag('verbose')) console.log('  settings body: ' + JSON.stringify(write.json).slice(0, 400))
record(write.status === 200, 'POST /settings answers 200', 'status ' + write.status)
const after = await call('GET', '/state')
const policy = after.json && after.json.settings ? after.json.settings.updatePolicy : undefined
record(policy === 'manual', 'POST /settings persists updatePolicy', 'policy=' + policy)

// ---- 6. serialisation guard: two concurrent mutating calls ----------------
const [a, b] = await Promise.all([call('POST', '/engines/verify', {}), call('POST', '/engines/verify', {})])
if (flag('verbose')) console.log('  verify bodies: ' + JSON.stringify([a.json, b.json]).slice(0, 700))
const busy = [a, b].filter((r) => r.json && r.json.error && r.json.error.code === 'busy')
record(a.status < 500 && b.status < 500, 'concurrent verify does not 500', 'statuses ' + a.status + '/' + b.status)
record(busy.length <= 1, 'concurrent verify is serialised or both succeed', busy.length + ' busy refusal(s)')

// ---- 7. optional live doctor ----------------------------------------------
if (flag('doctor')) {
  const doctor = await call('GET', '/doctor')
  record(doctor.status === 200, 'GET /doctor answers 200', 'status ' + doctor.status)
  const d = doctor.json
  if (d && typeof d === 'object') {
    record(typeof d.toolCount === 'number' && d.toolCount >= 200, 'doctor reports >= 200 tools', d.toolCount)
    record(typeof d.availableGroups === 'number' && typeof d.totalGroups === 'number', 'doctor reports group counts', d.availableGroups + '/' + d.totalGroups)
  } else {
    record(false, 'GET /doctor answers JSON', doctor.text.slice(0, 120))
  }
}

rmSync(scratch, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok).length
console.log('')
console.log(results.length + ' checks · ' + (results.length - failed) + ' pass · ' + failed + ' fail')
process.exit(failed === 0 ? 0 : 1)
