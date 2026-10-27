#!/usr/bin/env node
// Independent end-to-end verifier for rea-powerpack.
//
// It does NOT import the plugin's modules (deliberately: an independent check).
// It spawns the real launcher the same way the harness would, performs a raw
// MCP stdio handshake, then asks REA's own `binary_session` tool which tool
// groups are available — that report is the ground truth for "did the engines
// actually get wired up".
//
// Usage:
//   node dev/verify-mcp.mjs [--profile <dir>] [--pkg <dir>] [--json] [--keep]
//
// Exit codes: 0 all good, 1 handshake failed, 2 provider gaps remain, 3 usage.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes('--' + name);

const profile = arg('profile', join(homedir(), '.dsh', 'profiles', 'desktop'));
const pkg = arg('pkg', join(profile, 'node_modules', 'dsh-rea-powerpack'));
const launcher = arg('launcher', join(pkg, 'lib', 'rea-mcp.mjs'));
// Repeatable --env KEY=VALUE overrides, so this can also probe an engine set against
// any launcher, before or after the plugin is installed.
const envOverrides = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--env' && argv[i + 1]) { const eq = argv[i + 1].indexOf('='); envOverrides[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1); }
}
const home = process.env.REA_POWERPACK_HOME || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'rea-powerpack');
const manifestPath = join(home, 'engines.json');

const fail = (code, msg) => { console.error('FAIL: ' + msg); process.exit(code); };

if (!existsSync(launcher)) fail(3, 'launcher not found: ' + launcher);

let manifest = null;
if (existsSync(manifestPath)) {
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) { fail(3, 'engines.json is not valid JSON: ' + e.message); }
} else {
  console.warn('WARN: no engines.json at ' + manifestPath + ' — starting with an empty engine set');
}

const child = spawn(process.execPath, [launcher, profile, 'mcp'], {
  cwd: profile,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...envOverrides },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

const pending = new Map();
let nextId = 1;
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});

const request = (method, params, timeoutMs = 60000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout waiting for ' + method)); }, timeoutMs);
  pending.set(id, {
    resolve: (v) => { clearTimeout(timer); resolve(v); },
    reject: (e) => { clearTimeout(timer); reject(e); },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const cleanup = () => { try { child.kill('SIGKILL'); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

const run = async () => {
  const startedAt = Date.now();
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'rea-powerpack-verify', version: '0.0.0' },
  });
  notify('notifications/initialized', {});

  const server = init.serverInfo || {};
  const tools = [];
  let cursor;
  do {
    const page = await request('tools/list', cursor ? { cursor } : {}, 120000);
    tools.push(...(page.tools || []));
    cursor = page.nextCursor;
  } while (cursor);

  const handshakeMs = Date.now() - startedAt;
  const out = {
    launcher,
    profile,
    manifestPath,
    server,
    instructions: (init.instructions || '').split('\n')[0].slice(0, 160),
    toolCount: tools.length,
    // Opt-in so the default report stays small; used by the tool-baseline drift check.
    ...(argv.includes('--list-tools') ? { tools: tools.map((tool) => tool.name) } : {}),
    handshakeMs,
    engines: manifest?.engines?.map((e) => ({ id: e.id, version: e.version, verified: e.verified, path: e.path })) ?? [],
  };

  // Ask REA itself which tool groups are unavailable, and why.
  // Shape (verified against live REA 6.8.0): result.tool_availability = {
  //   client_requirements: {...}, groups: [{ names[], surface, effects[], annotations[],
  //   available, reason, remediation, default_mode_available, modes }] }
  if (tools.some((t) => t.name === 'binary_session')) {
    try {
      const res = await request('tools/call', { name: 'binary_session', arguments: {} }, 180000);
      const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      const avail = parsed?.result?.tool_availability || parsed?.tool_availability || {};
      const groups = Array.isArray(avail.groups) ? avail.groups : [];
      const isDown = (g) => g.available === false;
      const down = groups.filter(isDown);
      const byReason = {};
      for (const g of down) byReason[g.reason || 'unknown'] = (byReason[g.reason || 'unknown'] || 0) + 1;
      out.availability = {
        clientRequirements: avail.client_requirements || null,
        groups: groups.length,
        available: groups.length - down.length,
        toolsInAvailableGroups: groups.filter((g) => !isDown(g)).reduce((n, g) => n + (g.names?.length || 0), 0),
        byReason,
        unavailable: down.map((g) => ({
          surface: g.surface,
          tools: g.names?.length || 0,
          sample: (g.names || []).slice(0, 4).join(','),
          reason: g.reason,
          remediation: String(g.remediation || '').slice(0, 240),
        })),
      };
    } catch (e) {
      out.availability = { error: String(e.message).slice(0, 300) };
    }
  }

  console.log(JSON.stringify(out, null, 2));
  console.error('--- launcher stderr ---\n' + (stderr.trim() || '(empty)'));

  // A real gap is a provider we were supposed to supply on this host but that is
  // missing/broken. target_required resolves itself once a target is opened;
  // unsupported_host cannot be fixed on Windows; JEB is a commercial client we skip.
  const IGNORED_SURFACES = new Set(['jeb-provider']);
  const gaps = (out.availability?.unavailable || []).filter(
    (g) => (g.reason === 'provider_unavailable' || g.reason === 'provider_missing') && !IGNORED_SURFACES.has(g.surface)
  );
  if (out.toolCount < 200) fail(1, 'tool count ' + out.toolCount + ' < 200 — server started but looks wrong');
  if (gaps.length) {
    console.error('GAPS REMAIN (' + gaps.length + '):');
    for (const g of gaps) console.error('  - ' + g.surface + ' [' + g.reason + '] tools=' + g.tools + ' -> ' + g.remediation);
    process.exit(2);
  }
  console.log('OK: ' + out.toolCount + ' tools, ' + (out.availability?.available ?? '?') + '/' + (out.availability?.groups ?? '?') + ' groups available, ' + (out.availability?.toolsInAvailableGroups ?? '?') + ' tools in available groups');
  process.exit(0);
};

run().catch((e) => { console.error(e); console.error(stderr.slice(-2000)); process.exit(1); });