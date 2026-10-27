#!/usr/bin/env node
// One command that runs every gate the Lead cares about, in order, and prints a
// single verdict. Each stage is an independent process so a hang in one cannot
// stall the others.
//
//   node dev/gate.mjs            all stages
//   node dev/gate.mjs --fast     skip the two stages that spawn REA
//
// Exit: 0 everything green · 1 any hard failure · 2 only warnings

import { execFile } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { locateLayout } from './_layout.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const { repo: REPO, workspace: ROOT } = locateLayout(HERE)
const argv = process.argv.slice(2)
const fast = argv.includes('--fast')

const run = (label, args, cwd, timeout) => new Promise((done) => {
  const started = Date.now()
  execFile(process.execPath, args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    done({
      label,
      code: error && typeof error.code === 'number' ? error.code : (error ? 1 : 0),
      out: String(stdout || '') + String(stderr || ''),
      ms: Date.now() - started,
    })
  })
})

/** Last meaningful line of a stage's output, so the summary stays readable. */
const tail = (text) => {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const checks = lines.find((l) => /checks ·/.test(l))
  const ok = lines.find((l) => /^OK: /.test(l))
  const fail = lines.filter((l) => /^(FAIL|✖)/.test(l)).slice(0, 3)
  return [ok, checks, ...fail].filter(Boolean).join(' | ') || lines[lines.length - 1] || ''
}

// Stage order: the cheap structural gate first, then the live-route probe, then
// the package's own tests. `node --test` with no path discovers test/**/*.test.mjs.
const stages = []
stages.push(['acceptance', await run('acceptance', [join(HERE, 'acceptance.mjs'), ...(fast ? ['--skip-mcp'] : [])], ROOT, 240000)])
stages.push(['http routes', await run('http routes', [join(HERE, 'http-probe.mjs'), ...(fast ? [] : ['--doctor'])], ROOT, 240000)])
stages.push(['unit tests', await run('unit tests', ['--test'], REPO, 300000)])

console.log('')
console.log('================ gate ================')
let fail = 0
let warn = 0
for (const [name, result] of stages) {
  const state = result.code === 0 ? 'PASS' : (result.code === 2 || result.code === 3) ? 'WARN' : 'FAIL'
  if (state === 'FAIL') fail++
  if (state === 'WARN') warn++
  console.log(state + '  ' + name.padEnd(12) + 'exit=' + result.code + '  ' + (result.ms / 1000).toFixed(1) + 's  ' + tail(result.out))
}
console.log('=====================================')
console.log(fail === 0 ? (warn === 0 ? 'ALL GREEN' : 'GREEN with ' + warn + ' warning(s)') : fail + ' stage(s) failed')
process.exit(fail > 0 ? 1 : warn > 0 ? 2 : 0)
