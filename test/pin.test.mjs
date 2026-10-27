import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readPin,
  writePin,
  compareVersions,
  decideUpgrade,
  probeServer,
  MIN_TOOL_COUNT,
  HANDSHAKE_TIMEOUT_MS,
} from '../lib/pin.js';

const silent = async () => {};

async function makeHome() {
  return mkdtemp(join(tmpdir(), 'rea-powerpack-pin-'));
}

// --------------------------------------------------------------- pin.json --

test('pin: a missing pin.json reads as an empty pin and never throws', async () => {
  const home = await makeHome();
  try {
    const pin = await readPin(home);
    assert.deepEqual(pin, {
      version: null,
      requested: null,
      pinnedAt: null,
      pinnedFrom: null,
      retained: null,
      withheldBuilds: [],
      latestKnown: null,
      checkedAt: null,
    });
  } finally {
    await cleanup(home);
  }
});

test('pin: writePin round-trips every field and normalises junk', async () => {
  const home = await makeHome();
  try {
    const written = await writePin(home, {
      version: '6.5.0',
      requested: '6.5.0',
      pinnedAt: '2025-08-01T10:00:00.000Z',
      pinnedFrom: 'ui',
      retained: { from: '6.4.2', at: '2025-08-01T10:00:00.000Z' },
      withheldBuilds: ['6.6.0', 42, null, '6.7.0'],
      latestKnown: '6.6.0',
      checkedAt: '2025-08-01T09:59:00.000Z',
    });
    assert.equal(written.version, '6.5.0');
    assert.equal(written.pinnedFrom, 'ui');
    assert.deepEqual(written.withheldBuilds, ['6.6.0', '6.7.0']);
    const raw = JSON.parse(await readFile(join(home, 'pin.json'), 'utf8'));
    assert.deepEqual(raw, written, 'the file and the returned value agree');
    const reread = await readPin(home);
    assert.deepEqual(reread, written, 'a second read sees the same pin');
  } finally {
    await cleanup(home);
  }
});

test('pin: invalid values collapse instead of leaking through', async () => {
  const home = await makeHome();
  try {
    const written = await writePin(home, {
      version: '',
      requested: null,
      pinnedFrom: 'nowhere',
      retained: { at: '2025-01-01T00:00:00.000Z' },
      withheldBuilds: 'not-an-array',
      latestKnown: 5,
    });
    assert.equal(written.version, null);
    assert.equal(written.pinnedFrom, null, 'an unknown pin source is dropped');
    assert.equal(written.retained, null, 'retained needs a from version');
    assert.deepEqual(written.withheldBuilds, []);
    assert.equal(written.latestKnown, null);
  } finally {
    await cleanup(home);
  }
});

test('pin: a corrupt pin.json degrades to an empty pin', async () => {
  const home = await makeHome();
  try {
    await writeFile(join(home, 'pin.json'), '{ not json', 'utf8');
    const pin = await readPin(home);
    assert.equal(pin.version, null);
    assert.deepEqual(pin.withheldBuilds, []);
  } finally {
    await cleanup(home);
  }
});

// --------------------------------------------------------------- versions --

test('versions: semver ordering including prerelease', () => {
  assert.equal(compareVersions('6.5.0', '6.5.0'), 0);
  assert.equal(compareVersions('6.5.0', '6.6.0'), -1);
  assert.equal(compareVersions('6.6.0', '6.5.0'), 1);
  assert.equal(compareVersions('6.5.0', '6.5.1'), -1);
  assert.equal(compareVersions('v6.5.0', '6.5.0'), 0, 'a leading v is tolerated');
  assert.equal(compareVersions('6.8.0-rc.1', '6.8.0'), -1, 'a prerelease sorts before its release');
  assert.equal(compareVersions('6.8.0', '6.8.0-rc.1'), 1);
  assert.equal(compareVersions('6.8.0-rc.1', '6.8.0-rc.2'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1, 'numeric prerelease identifiers compare as numbers');
  assert.equal(compareVersions('1.0.0+build.1', '1.0.0+build.2'), 0, 'build metadata is ignored');
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-2', '1.0.0-10'), -1);
  assert.equal(compareVersions('not-a-version', '1.0.0'), -1, 'an unparseable version sorts first');
  assert.equal(compareVersions('1.0.0', 'not-a-version'), 1);
});

// ----------------------------------------------------------- decideUpgrade --

test('decideUpgrade: the decision matrix holds', () => {
  const cases = [
    { name: 'no latest known', input: { pinned: '6.5.0', latest: null, policy: 'notify' }, action: 'none', reason: 'no_latest_version_known' },
    { name: 'rea missing', input: { pinned: null, latest: '6.6.0', policy: 'notify' }, action: 'none', reason: 'rea_not_installed' },
    { name: 'up to date', input: { pinned: '6.6.0', latest: '6.6.0', policy: 'notify' }, action: 'none', reason: 'up_to_date' },
    { name: 'pinned is ahead', input: { pinned: '6.7.0', latest: '6.6.0', policy: 'notify' }, action: 'none', reason: 'up_to_date' },
    { name: 'notify', input: { pinned: '6.5.0', latest: '6.6.0', policy: 'notify' }, action: 'notify', reason: 'newer_version_available' },
    { name: 'notify stays notify when idle', input: { pinned: '6.5.0', latest: '6.6.0', policy: 'notify', runningTurns: 0 }, action: 'notify', reason: 'newer_version_available' },
    { name: 'auto-idle, idle', input: { pinned: '6.5.0', latest: '6.6.0', policy: 'auto-idle', runningTurns: 0 }, action: 'upgrade', reason: 'newer_version_available' },
    { name: 'auto-idle, busy', input: { pinned: '6.5.0', latest: '6.6.0', policy: 'auto-idle', runningTurns: 2 }, action: 'notify', reason: 'busy' },
    { name: 'auto-idle, up to date', input: { pinned: '6.6.0', latest: '6.6.0', policy: 'auto-idle' }, action: 'none', reason: 'up_to_date' },
    { name: 'manual', input: { pinned: '6.5.0', latest: '6.6.0', policy: 'manual' }, action: 'none', reason: 'manual_policy' },
    { name: 'manual, up to date', input: { pinned: '6.6.0', latest: '6.6.0', policy: 'manual' }, action: 'none', reason: 'up_to_date' },
    { name: 'a prerelease counts as newer', input: { pinned: '6.8.0-rc.1', latest: '6.8.0', policy: 'notify' }, action: 'notify', reason: 'newer_version_available' },
    { name: 'an unknown policy falls through to auto-idle when idle', input: { pinned: '6.5.0', latest: '6.6.0', policy: 'whatever' }, action: 'upgrade', reason: 'newer_version_available' },
    { name: 'an unknown policy falls through to auto-idle when busy', input: { pinned: '6.5.0', latest: '6.6.0', policy: 'whatever', runningTurns: 1 }, action: 'notify', reason: 'busy' },
  ];
  for (const item of cases) {
    const outcome = decideUpgrade(item.input);
    assert.equal(outcome.action, item.action, item.name + ': action');
    assert.equal(outcome.reason, item.reason, item.name + ': reason');
  }
});

test('decideUpgrade: a newer release always beats a pinned prerelease', () => {
  assert.equal(decideUpgrade({ pinned: '6.8.0-rc.1', latest: '6.8.0', policy: 'auto-idle', runningTurns: 0 }).action, 'upgrade');
  assert.equal(decideUpgrade({ pinned: '6.8.0', latest: '6.8.0-rc.1', policy: 'auto-idle', runningTurns: 0 }).action, 'none');
});

// --------------------------------------------------------------- handshake --

const FAKE_SERVER = `// A stand-in REA MCP server that answers initialize and paginated tools/list.
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
const tools = ['rea_list_procedures', 'rea_decompile', 'rea_search_strings'];
const more = ['rea_read_bytes'];
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: '2025-06-18', serverInfo: { name: 'rea-agents', version: '6.5.0' }, capabilities: { tools: {} } },
    }) + '\\n');
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    const cursor = message.params && message.params.cursor;
    if (cursor === 'page-2') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: more.map((name) => ({ name })) } }) + '\\n');
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: tools.map((name) => ({ name })), nextCursor: 'page-2' },
    }) + '\\n');
  }
});
`;

const BROKEN_SERVER = `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'no engines' } }) + '\\n');
  }
});
`;

const DYING_SERVER = `process.exit(3);
`;

/**
 * Windows keeps the killed child's cwd handle briefly; retry the cleanup so a
 * passing assertion is not reported as an EBUSY failure.
 */
async function cleanup(path) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function withServer(source, run) {
  const home = await mkdtemp(join(tmpdir(), 'rea-powerpack-handshake-'));
  const entry = join(home, 'fake-rea.cjs');
  await writeFile(entry, source, 'utf8');
  try {
    return await run({ home, entry });
  } finally {
    await cleanup(home);
  }
}

test('handshake: probeServer parses serverInfo, protocolVersion and every tools/list page', async () => {
  await withServer(FAKE_SERVER, async ({ home, entry }) => {
    const probed = await probeServer(home, { home, entry, timeoutMs: 5000 });
    assert.equal(probed.serverInfo.name, 'rea-agents');
    assert.equal(probed.serverInfo.version, '6.5.0');
    assert.equal(probed.protocolVersion, '2025-06-18');
    assert.equal(probed.toolCount, 4, 'both pages are counted');
    assert.deepEqual(probed.toolNames, [
      'rea_list_procedures',
      'rea_decompile',
      'rea_search_strings',
      'rea_read_bytes',
    ]);
  });
});

test('handshake: an initialize error becomes preflight_failed', async () => {
  await withServer(BROKEN_SERVER, async ({ home, entry }) => {
    await assert.rejects(
      () => probeServer(home, { home, entry, timeoutMs: 5000 }),
      (error) => {
        assert.equal(error.code, 'preflight_failed');
        assert.match(error.message, /initialize failed/);
        return true;
      },
    );
  });
});

test('handshake: a child that dies early becomes rea_missing', async () => {
  await withServer(DYING_SERVER, async ({ home, entry }) => {
    await assert.rejects(
      () => probeServer(home, { home, entry, timeoutMs: 5000 }),
      (error) => {
        assert.equal(error.code, 'rea_missing');
        assert.match(error.message, /exited before completing the handshake/);
        return true;
      },
    );
  });
});

test('handshake: a missing entry point becomes rea_missing without spawning', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rea-powerpack-missing-'));
  try {
    await assert.rejects(
      () => probeServer(home, { home, entry: null, timeoutMs: 1000 }),
      (error) => {
        assert.equal(error.code, 'rea_missing');
        return true;
      },
    );
  } finally {
    await cleanup(home);
  }
});

test('handshake: the preflight floor is the documented 200 tools', () => {
  assert.equal(MIN_TOOL_COUNT, 200);
  assert.equal(HANDSHAKE_TIMEOUT_MS, 10000);
});

test('pin: upgrade refuses a conflicting pin before touching pnpm', async () => {
  const home = await makeHome();
  try {
    await writePin(home, { version: '6.5.0', requested: '6.5.0', pinnedFrom: 'cli' });
    const calls = [];
    const exec = async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: '', stderr: '' };
    };
    const { upgradeRea } = await import('../lib/pin.js');
    await assert.rejects(
      () => upgradeRea(home, home, '6.6.0', { exec, log: silent }),
      (error) => {
        assert.equal(error.code, 'pin_conflict');
        return true;
      },
    );
    assert.deepEqual(calls, [], 'pnpm is never invoked for a conflicting pin');
  } finally {
    await cleanup(home);
  }
});

test('pin: rollback without a retained build fails cleanly', async () => {
  const home = await makeHome();
  try {
    const { rollback } = await import('../lib/pin.js');
    await assert.rejects(
      () => rollback(home, home, { exec: async () => ({ stdout: '' }), log: silent }),
      (error) => {
        assert.equal(error.code, 'rollback_failed');
        return true;
      },
    );
  } finally {
    await cleanup(home);
  }
});

test('pin: upgrade rejects a non-semver version as bad_request', async () => {
  const home = await makeHome();
  try {
    const { upgradeRea } = await import('../lib/pin.js');
    await assert.rejects(
      () => upgradeRea(home, home, 'latest', { exec: async () => ({ stdout: '' }), log: silent }),
      (error) => {
        assert.equal(error.code, 'bad_request');
        return true;
      },
    );
  } finally {
    await cleanup(home);
  }
});

test('pin: state files are created under the powerpack home only', async () => {
  const home = await makeHome();
  try {
    await writePin(home, { version: '6.5.0' });
    assert.equal(existsSync(join(home, 'pin.json')), true);
  } finally {
    await cleanup(home);
  }
});
