#!/usr/bin/env node
// Install / uninstall dsh-rea-powerpack into a DSH profile (development link mode).
//
// What it does (and nothing else):
//   1. back up profile/package.json, profile/cordis.patch.yml, profile/pnpm-lock.yaml
//   2. `pnpm add "link:<repo>" --save-exact` in the profile (live junction: edits in the
//      repo are visible without reinstalling)
//   3. add "dsh-rea-powerpack" to dsh.profile.bundles and drop "dsh-rea-agents" from it
//      (both bundles mount an MCP client row named `rea`; running both would collide)
//   4. strip stale `- id: rea-agents*` entries from profile/cordis.patch.yml, keeping them
//      in the backup file
//
// A restart of the harness is required afterwards: the bundle list and patch layers are
// composed once at boot (see @deepseek-ai/dsh-app-boot profile-boot).
//
// Usage:
//   node dev/install-plugin.mjs [--profile <dir>] [--repo <dir>] [--dry-run] [--uninstall]

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { locateRepo } from './_layout.mjs';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const defaultRepo = locateRepo(here);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const dryRun = flag('dry-run');
const uninstall = flag('uninstall');
const profile = resolve(opt('profile', join(homedir(), '.dsh', 'profiles', 'desktop')));
const repo = resolve(opt('repo', defaultRepo));
const pkgName = 'dsh-rea-powerpack';
const oldBundle = 'dsh-rea-agents';

const log = (...a) => console.log(...a);
const die = (msg) => { console.error('ERROR: ' + msg); process.exit(1); };

if (!existsSync(join(profile, 'package.json'))) die('not a dsh profile (no package.json): ' + profile);
if (!existsSync(join(repo, 'package.json'))) die('package not found: ' + repo);
const meta = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
if (meta.name !== pkgName) die('unexpected package name ' + meta.name);

// ---------- backup ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = join(profile, '.rea-powerpack-backup', stamp);
const files = ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml'];
if (!dryRun) {
  mkdirSync(backupDir, { recursive: true });
  for (const f of files) {
    const src = join(profile, f);
    if (existsSync(src)) copyFileSync(src, join(backupDir, f));
  }
}
log('backup dir:', dryRun ? '(dry-run, skipped)' : backupDir);

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const pkgPath = join(profile, 'package.json');
const patchPath = join(profile, 'cordis.patch.yml');

// ---------- pnpm ----------
// Windows has no POSIX exec target for pnpm: the installed entry point is a
// console script (pnpm.cmd / pnpm.ps1), and Node refuses to spawn a .cmd
// without a shell. The harness also ships its own pnpm as a .mjs entry point.
// Both shapes are handled explicitly so no argument is ever re-parsed by a
// shell: cmd.exe receives the argv array, and a .mjs runs under this Node.
const pnpmInvocation = (args) => {
  const configured = process.env.DSH_PNPM_PATH
  const command = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : 'pnpm'
  if (/\.[cm]?js$/u.test(command)) return { file: process.execPath, args: [command, ...args] }
  if (process.platform === 'win32') return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] }
  return { file: command, args }
}

const pnpm = async (args) => {
  log('$ pnpm ' + args.join(' '));
  if (dryRun) return;
  const invocation = pnpmInvocation(args);
  try {
    const { stdout, stderr } = await execFileAsync(invocation.file, invocation.args, {
      cwd: profile, timeout: 20 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: false,
    });
    if (stdout.trim()) log(stdout.trim().split('\n').slice(-12).join('\n'));
    if (stderr.trim()) log(stderr.trim().split('\n').slice(-6).join('\n'));
  } catch (e) {
    die('pnpm ' + args.join(' ') + ' failed: ' + (e.stderr || e.message));
  }
};

// ---------- bundles ----------
const setBundles = (pkg, add, remove) => {
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  const list = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles.slice() : [];
  const next = list.filter((b) => b !== remove && b !== add);
  if (add) next.push(add);
  pkg.dsh.profile.bundles = next;
  return next;
};

// ---------- stale rea-agents patch entries ----------
// The dsh-rea-agents bundle inserted its own mcp-client row with serverName
// "rea". Two live mcp-client instances cannot share a serverName (the host
// throws "serverName \"rea\" is already in use by another mcp-client
// instance"). Once the bundle leaves dsh.profile.bundles, that profile-level
// row has no bundle layer left to supply its config — a config-less mcp-client
// row is not a valid row at all — so the block is REMOVED rather than
// disabled. The removal is idempotent and stays byte-faithful everywhere else.
//
// Block shape:
//   - id: rea-agents-mcp
//     name: "@deepseek-ai/dsh-mcp-client"
//     disabled: false
// (possibly indented under a list; trailing blank line is collapssed).
const stripReaAgentsEntries = (text) => {
  const lines = text.split(/\r?\n/);
  const out = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)- id:\s*(rea-agents\S*)\s*$/.exec(lines[i]);
    if (!match) { out.push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j]) && !/^\s*-\s/.test(lines[j])) j++;
    // Swallow the blank separator line that followed the block, if any.
    if (j < lines.length && lines[j].trim() === '' && out.length > 0 && out[out.length - 1].trim() === '') j++;
    removed++;
    i = j - 1;
  }
  return { text: out.join('\n'), removed };
};

const run = async () => {
  const pkg = readJson(pkgPath);
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  const { text: cleaned, removed } = stripReaAgentsEntries(patch);
  if (removed) log('removing ' + removed + ' stale dsh-rea-agents patch entr' + (removed === 1 ? 'y' : 'ies') + ' (no bundle layer supplies their config)');

  if (uninstall) {
    await pnpm(['remove', pkgName]);
    // pnpm rewrites package.json, so re-read it instead of persisting our stale copy.
    const current = readJson(pkgPath);
    setBundles(current, null, pkgName);
    writeJson(pkgPath, current);
    if (!dryRun) writeFileSync(patchPath, cleaned);
    log('uninstalled. restart the harness to drop the rows.');
    return;
  }

  await pnpm(['add', 'link:' + repo, '--save-exact']);
  // pnpm rewrites package.json (adds the dependency), so bundles must be written
  // onto a FRESH read — persisting the pre-add copy silently drops the dependency.
  const after = readJson(pkgPath);
  const bundles = setBundles(after, pkgName, oldBundle);
  if (!dryRun) {
    writeJson(pkgPath, after);
    writeFileSync(patchPath, cleaned);
  }
  log('bundles now: ' + bundles.join(', '));
  log('');
  log('OK. Restart DeepSeek Harness to load the plugin (bundle list is read at boot).');
  log('After restart: node dev/verify-mcp.mjs   # expects toolCount >= 200');
};

run().catch((e) => die(e.stack || String(e)));
