// State-file and environment tests. Every path lives under os.tmpdir(); the
// real profile and the user's home are never touched, and no child process is
// started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  composeEnv,
  engineRoot,
  isWritable,
  powerpackHome,
  readManifest,
  readSettings,
  readState,
  writeManifest,
  writeSettings,
  writeState,
} from '../lib/engines.js';

const saved = {
  home: process.env.REA_POWERPACK_HOME,
  localAppData: process.env.LOCALAPPDATA,
  adb: process.env.REA_ADB_PATH,
  jadx: process.env.REA_JADX_MCP_JAR,
  ghidra: process.env.REA_GHIDRA_DIR,
};

function restoreEnv() {
  for (const [key, value] of [
    ['REA_POWERPACK_HOME', saved.home],
    ['LOCALAPPDATA', saved.localAppData],
    ['REA_ADB_PATH', saved.adb],
    ['REA_JADX_MCP_JAR', saved.jadx],
    ['REA_GHIDRA_DIR', saved.ghidra],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function tempHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rpp-home-'));
  return dir;
}

/** A manifest record with the normalised shape readManifest returns. */
function record(overrides) {
  return Object.assign(
    {
      id: 'x',
      name: 'x',
      tier: 1,
      version: null,
      path: null,
      envVar: null,
      pathPrepend: false,
      sha256: null,
      verified: false,
      rawVersionOutput: null,
      installedAt: null,
      source: 'test',
    },
    overrides,
  );
}

test.after(function afterAll() {
  restoreEnv();
});

test('powerpackHome honours REA_POWERPACK_HOME and otherwise resolves per platform', async function () {
  const home = await tempHome();
  try {
    process.env.REA_POWERPACK_HOME = home;
    assert.equal(powerpackHome('C:\\profile'), path.resolve(home));
    process.env.REA_POWERPACK_HOME = '   ';
    const local = await tempHome();
    process.env.LOCALAPPDATA = local;
    assert.equal(powerpackHome('C:\\profile'), path.join(local, 'rea-powerpack'));
    delete process.env.REA_POWERPACK_HOME;
    assert.equal(powerpackHome('C:\\profile'), path.join(local, 'rea-powerpack'));
  } finally {
    restoreEnv();
  }
});

test('engineRoot defaults under the home and accepts an absolute override', async function () {
  const home = await tempHome();
  const custom = await tempHome();
  assert.equal(engineRoot(home, {}), path.join(home, 'engines'));
  assert.equal(engineRoot(home, { engineRoot: custom }), path.resolve(custom));
  assert.equal(engineRoot(home, { engineRoot: 'relative/engines' }), path.join(home, 'engines'));
  assert.equal(engineRoot(home, { engineRoot: null }), path.join(home, 'engines'));
});

test('manifest: absent file yields the documented empty shape', async function () {
  const home = await tempHome();
  const manifest = await readManifest(home);
  assert.deepEqual(manifest, {
    version: 1,
    root: path.join(home, 'engines'),
    updatedAt: null,
    engines: [],
  });
});

test('manifest: round-trips records and normalises unknown fields', async function () {
  const home = await tempHome();
  const written = await writeManifest(home, {
    root: path.join(home, 'engines'),
    engines: [
      record({ id: 'adb', name: 'Android Platform Tools', path: 'C:\\engines\\adb.exe', verified: true, version: '35.0.1' }),
      record({ id: 'python', tier: 1, pathPrepend: true, extraEnv: { REA_X: '1' }, source: 'winget' }),
      { id: 'junk' },
    ],
  });
  assert.equal(written.version, 1);
  assert.equal(written.engines.length, 3, 'any record with a string id is kept');
  assert.match(written.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const reread = await readManifest(home);
  assert.equal(reread.version, 1);
  assert.equal(reread.updatedAt, written.updatedAt);
  assert.deepEqual(
    reread.engines.map(function id(item) {
      return item.id;
    }),
    ['adb', 'python', 'junk'],
  );
  const adb = reread.engines[0];
  assert.equal(adb.path, 'C:\\engines\\adb.exe');
  assert.equal(adb.verified, true);
  assert.equal(adb.version, '35.0.1');
  assert.equal(adb.extraEnv, undefined);
  const python = reread.engines[1];
  assert.equal(python.pathPrepend, true);
  assert.equal(python.source, 'winget');
  assert.equal(python.tier, 1);
  assert.equal(python.name, 'x', 'the provided name is preserved');
  const junk = reread.engines[2];
  assert.equal(junk.tier, 2, 'a missing tier defaults to two');
  assert.equal(junk.verified, false);
  assert.equal(junk.name, 'junk');
});

test('manifest: a corrupt file reads as empty instead of throwing', async function () {
  const home = await tempHome();
  await fs.writeFile(path.join(home, 'engines.json'), '{not json', 'utf8');
  const manifest = await readManifest(home);
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.engines, []);
});

test('state files: settings merge over defaults and clamp out-of-range values', async function () {
  const home = await tempHome();
  assert.deepEqual(await readSettings(home), DEFAULT_SETTINGS);
  const merged = await writeSettings(home, {
    updatePolicy: 'auto-idle',
    toolTimeoutMs: 10,
    checkIntervalHours: 9999,
    engineRoot: path.join(home, 'custom'),
  });
  assert.equal(merged.updatePolicy, 'auto-idle');
  assert.equal(merged.toolTimeoutMs, DEFAULT_SETTINGS.toolTimeoutMs, 'too-small timeout is ignored');
  assert.equal(merged.checkIntervalHours, 24 * 7, 'interval clamps to one week');
  assert.equal(merged.engineRoot, path.join(home, 'custom'));
  assert.equal(merged.locale, 'auto');

  const reread = await readSettings(home);
  assert.deepEqual(reread, merged);

  const rejected = await writeSettings(home, { updatePolicy: 'always', locale: 'fr', engineRoot: null });
  assert.equal(rejected.updatePolicy, 'auto-idle', 'unknown policy is ignored');
  assert.equal(rejected.locale, 'auto', 'unknown locale is ignored');
  assert.equal(rejected.engineRoot, null, 'null clears the override');
});

test('state files: state.json merges lastDoctor and lastReload', async function () {
  const home = await tempHome();
  assert.deepEqual(await readState(home), { lastDoctor: null, lastReload: null });
  const doctor = { at: '2026-10-01T00:00:00.000Z', toolCount: 200, availableGroups: 6, totalGroups: 6 };
  await writeState(home, { lastDoctor: doctor });
  const afterDoctor = await writeState(home, { lastReload: { at: '2026-10-02T00:00:00.000Z', ok: true, mode: 'hot' } });
  assert.deepEqual(afterDoctor.lastDoctor, doctor);
  assert.equal(afterDoctor.lastReload.mode, 'hot');
  const reread = await readState(home);
  assert.deepEqual(reread.lastDoctor, doctor);
  assert.equal(reread.lastReload.ok, true);
});

test('isWritable reports a writable directory and a blocked one', async function () {
  const home = await tempHome();
  assert.equal(await isWritable(home), true);
  const file = path.join(home, 'not-a-directory');
  await fs.writeFile(file, 'x', 'utf8');
  const blocked = await isWritable(file);
  assert.equal(typeof blocked, 'boolean');
});

test('composeEnv: an empty manifest reports every tier 0/1 engine as missing', async function () {
  const home = await tempHome();
  for (const key of ['REA_ADB_PATH', 'REA_JADX_MCP_JAR', 'REA_GHIDRA_DIR']) delete process.env[key];
  const composed = await composeEnv(home, {});
  assert.deepEqual(composed.env, {});
  assert.deepEqual(composed.pathPrepend, []);
  assert.deepEqual(composed.missing, ['java', 'ghidra', 'adb', 'apktool', 'jadx', 'wabt', 'python', 'frida']);
  assert.equal(composed.root, path.join(home, 'engines'));
  assert.deepEqual(composed.warnings, []);
});

test('composeEnv: verified records publish env vars in manifest order', async function () {
  const home = await tempHome();
  const jars = path.join(home, 'engines', 'jadx');
  const tools = path.join(home, 'engines', 'platform-tools');
  const scripts = path.join(home, 'engines', 'python', 'Scripts');
  const jdk = path.join(home, 'engines', 'jdk');
  for (const dir of [jars, tools, scripts, jdk]) await fs.mkdir(dir, { recursive: true });
  const jar = path.join(jars, 'jadx.jar');
  const adbExe = path.join(tools, 'adb.exe');
  const pythonExe = path.join(home, 'engines', 'python', 'python.exe');
  await fs.writeFile(jar, 'jar', 'utf8');
  await fs.writeFile(adbExe, 'exe', 'utf8');
  await fs.writeFile(pythonExe, 'exe', 'utf8');

  await writeManifest(home, {
    engines: [
      record({ id: 'jadx', envVar: 'REA_JADX_MCP_JAR', path: jar, verified: true }),
      record({ id: 'adb', envVar: 'REA_ADB_PATH', path: adbExe, verified: true }),
      record({ id: 'python', pathPrepend: true, path: pythonExe, verified: true }),
      record({ id: 'java', envVar: 'JAVA_HOME', path: jdk, verified: true }),
      record({ id: 'frida', pathPrepend: true, path: path.join(scripts, 'frida-ps.exe'), verified: true }),
    ],
  });
  for (const key of ['REA_ADB_PATH', 'REA_JADX_MCP_JAR', 'JAVA_HOME']) delete process.env[key];

  const composed = await composeEnv(home, {});
  assert.equal(composed.env.REA_JADX_MCP_JAR, jar);
  assert.equal(composed.env.REA_ADB_PATH, adbExe);
  assert.equal(composed.env.JAVA_HOME, jdk, 'a directory envKind exports the directory');
  assert.deepEqual(composed.pathPrepend, [
    path.dirname(pythonExe),
    path.join(home, 'engines', 'python', 'Scripts'),
  ]);
  assert.ok(!composed.missing.includes('jadx'));
  assert.ok(!composed.missing.includes('adb'));
  assert.ok(!composed.missing.includes('python'));
  assert.ok(composed.missing.includes('ghidra'), 'unverified engines stay missing');
});

test('composeEnv: pathPrepend dedupes case-insensitively and keeps first order', async function () {
  const home = await tempHome();
  const scripts = path.join(home, 'engines', 'python', 'Scripts');
  await fs.mkdir(scripts, { recursive: true });
  await writeManifest(home, {
    engines: [
      record({ id: 'python', pathPrepend: true, path: path.join(home, 'engines', 'python', 'python.exe'), verified: true }),
      record({ id: 'frida', pathPrepend: true, path: path.join(scripts, 'frida-ps.exe'), verified: true }),
      record({ id: 'mitmproxy', pathPrepend: true, path: path.join(scripts, 'mitmdump.exe'), verified: true }),
    ],
  });
  const composed = await composeEnv(home, {});
  assert.equal(composed.pathPrepend.length, 2, 'the Scripts directory appears once');
  assert.equal(composed.pathPrepend[0], path.join(home, 'engines', 'python'));
  assert.equal(composed.pathPrepend[1], scripts);
});

test('composeEnv: a user-set env var wins and is reported instead of overwritten', async function () {
  const home = await tempHome();
  const jar = path.join(home, 'jadx.jar');
  await fs.writeFile(jar, 'jar', 'utf8');
  await writeManifest(home, {
    engines: [record({ id: 'jadx', envVar: 'REA_JADX_MCP_JAR', path: jar, verified: true })],
  });
  const mine = path.join(home, 'my-jadx.jar');
  process.env.REA_JADX_MCP_JAR = mine;
  try {
    const composed = await composeEnv(home, {});
    assert.equal(composed.env.REA_JADX_MCP_JAR, undefined, 'the composed env does not shadow the user');
    assert.equal(process.env.REA_JADX_MCP_JAR, mine, 'the process environment is untouched');
    assert.equal(composed.env.REA_POWERPACK_OVERRIDES, 'REA_JADX_MCP_JAR');
  } finally {
    delete process.env.REA_JADX_MCP_JAR;
  }
});

test('composeEnv: extraEnv is honoured before verified env vars and never shadows the user', async function () {
  const home = await tempHome();
  process.env.REA_GHIDRA_DIR = 'C:\\user-ghidra';
  try {
    await writeManifest(home, {
      engines: [
        record({ id: 'ghidra', extraEnv: { REA_GHIDRA_DIR: 'C:\\managed-ghidra', REA_EXTRA: 'yes' } }),
      ],
    });
    const composed = await composeEnv(home, {});
    assert.equal(composed.env.REA_GHIDRA_DIR, undefined, 'the user variable wins');
    assert.equal(composed.env.REA_EXTRA, 'yes', 'unclaimed extraEnv keys are exported');
  } finally {
    delete process.env.REA_GHIDRA_DIR;
  }
});

test('composeEnv: a verified record without a path warns instead of guessing', async function () {
  const home = await tempHome();
  await writeManifest(home, {
    engines: [record({ id: 'wabt', envVar: 'REA_WABT_BIN_DIRECTORY', path: null, verified: true })],
  });
  delete process.env.REA_WABT_BIN_DIRECTORY;
  const composed = await composeEnv(home, {});
  assert.equal(composed.env.REA_WABT_BIN_DIRECTORY, undefined);
  assert.equal(composed.warnings.length, 1);
  assert.match(composed.warnings[0], /wabt/);
});
