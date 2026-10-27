// Catalog integrity. The catalog is pure data, so every rule in contract
// section 5 can be checked without touching the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_VERSION,
  ENGINES,
  byId,
  forPlatform,
  installableEngines,
  envVarNames,
} from '../lib/catalog.js';

const INSTALL_KINDS = ['zip', 'file', 'github-latest', 'winget', 'pip'];
const TIERS = [0, 1, 2];
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ENV_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;

test('catalog: version is 1 and there are 21 engines', function () {
  assert.equal(CATALOG_VERSION, 1);
  assert.ok(Array.isArray(ENGINES));
  assert.equal(ENGINES.length, 21, 'twenty-one engines: 2 tier-0, 6 tier-1, 13 tier-2');
});

test('catalog: ids are unique, lowercase and stable', function () {
  const seen = new Set();
  for (const spec of ENGINES) {
    assert.equal(typeof spec.id, 'string', 'every engine has an id');
    assert.match(spec.id, ID_PATTERN, 'id is kebab-case: ' + spec.id);
    assert.ok(!seen.has(spec.id), 'duplicate id: ' + spec.id);
    seen.add(spec.id);
  }
  assert.equal(seen.size, ENGINES.length);
});

test('catalog: ids cover the contract roster', function () {
  const expected = [
    'java', 'ghidra',
    'adb', 'apktool', 'jadx', 'wabt', 'frida', 'python',
    'objdump', 'rizin', 'dotnet', 'ilspy', 'mitmproxy',
    'tshark', 'capinfos', 'binwalk', 'unblob', 'sigrok', 'pwntools', 'wakaru', 'process-capture',
  ];
  for (const id of expected) assert.ok(byId(id) !== undefined, 'catalog has ' + id);
});

test('catalog: tier is 0, 1 or 2 on every entry', function () {
  for (const spec of ENGINES) {
    assert.ok(TIERS.includes(spec.tier), 'tier of ' + spec.id + ' is valid: ' + spec.tier);
  }
  const tierCounts = [0, 1, 2].map(function count(tier) {
    return ENGINES.filter(function same(spec) {
      return spec.tier === tier;
    }).length;
  });
  assert.deepEqual(tierCounts, [2, 6, 13]);
});

test('catalog: names are human-readable and unique', function () {
  const names = new Set();
  for (const spec of ENGINES) {
    assert.equal(typeof spec.name, 'string', spec.id + ' has a name');
    assert.ok(spec.name.length > 1, spec.id + ' name is not empty');
    assert.ok(!names.has(spec.name), 'duplicate name: ' + spec.name);
    names.add(spec.name);
  }
});

test('catalog: envVar follows SCREAMING_SNAKE_CASE and envKind fits it', function () {
  for (const spec of ENGINES) {
    if (spec.envVar === null) {
      assert.equal(spec.envKind, null, spec.id + ' has no envVar so envKind is null');
      continue;
    }
    assert.match(spec.envVar, ENV_PATTERN, spec.id + ' envVar: ' + spec.envVar);
    assert.ok(['file', 'dir'].includes(spec.envKind), spec.id + ' envKind is file or dir');
    assert.equal(typeof spec.pathPrepend, 'boolean', spec.id + ' declares pathPrepend');
  }
});

test('catalog: tier 0 names an envVar; tier 1 reaches the MCP through one', function () {
  for (const spec of ENGINES) {
    if (spec.tier === 0) assert.notEqual(spec.envVar, null, spec.id + ' (tier 0) has an envVar');
    if (spec.tier === 1) {
      assert.ok(
        spec.envVar !== null || spec.pathPrepend === true,
        spec.id + ' (tier 1) is exported via envVar or PATH',
      );
    }
  }
});

test('catalog: every declared sha256 is 64 lowercase hex characters', function () {
  let checked = 0;
  for (const spec of ENGINES) {
    const digests = [];
    if (spec.install && typeof spec.install.sha256 === 'string') digests.push(spec.install.sha256);
    if (typeof spec.sha256 === 'string') digests.push(spec.sha256);
    for (const digest of digests) {
      assert.match(digest, SHA_PATTERN, spec.id + ' sha256 is 64 hex chars');
      checked += 1;
    }
  }
  assert.ok(checked >= 1, 'at least the pinned jadx jar carries a digest');
  assert.equal(
    byId('jadx').install.sha256,
    '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75',
    'the jadx jar digest is the audited one',
  );
});

test('catalog: install.kind is one of the five supported kinds', function () {
  for (const spec of ENGINES) {
    if (spec.install === null) continue;
    assert.ok(INSTALL_KINDS.includes(spec.install.kind), spec.id + ' install kind: ' + spec.install.kind);
    if (spec.install.kind === 'zip' || spec.install.kind === 'file') {
      assert.ok(
        typeof spec.install.url === 'string' || typeof spec.install.urlTemplate === 'string',
        spec.id + ' download kind carries a url or urlTemplate',
      );
    }
    if (spec.install.kind === 'github-latest') {
      assert.equal(typeof spec.install.latestUrl, 'string', spec.id + ' latestUrl');
      assert.equal(typeof spec.install.asset, 'string', spec.id + ' asset template');
    }
    if (spec.install.kind === 'winget') {
      assert.match(spec.install.wingetId, /^[A-Za-z0-9.]+$/, spec.id + ' wingetId');
    }
    if (spec.install.kind === 'pip') {
      assert.ok(Array.isArray(spec.install.pipArgs) && spec.install.pipArgs.length > 0, spec.id + ' pipArgs');
    }
  }
});

test('catalog: engines offered for installation are installable on win32', function () {
  for (const spec of ENGINES) {
    if (spec.install === null) continue;
    assert.ok(spec.platforms.includes('win32'), spec.id + ' installable entries list win32');
    assert.notEqual(spec.hostUnsupported, 'win32', spec.id + ' is not both installable and unsupported');
  }
});

test('catalog: win32-unsupported engines are kept for the UI and explain themselves', function () {
  const unsupported = ENGINES.filter(function filter(spec) {
    return spec.hostUnsupported === 'win32';
  });
  assert.equal(unsupported.length, 8, 'eight Linux-only lanes are advertised as unsupported');
  for (const spec of unsupported) {
    assert.equal(typeof spec.notes, 'string', spec.id + ' has notes');
    assert.ok(spec.notes.length > 20, spec.id + ' notes explain the limitation');
    assert.equal(spec.install, null, spec.id + ' is not installable');
    assert.ok(spec.platforms.includes('win32'), spec.id + ' stays visible on win32');
  }
  const ids = unsupported.map(function id(spec) {
    return spec.id;
  });
  assert.deepEqual(ids, ['tshark', 'capinfos', 'binwalk', 'unblob', 'sigrok', 'pwntools', 'wakaru', 'process-capture']);
});

test('catalog: probe shape is executable, args array, optional match', function () {
  for (const spec of ENGINES) {
    if (spec.probe === null) continue;
    assert.equal(typeof spec.probe.exe, 'string', spec.id + ' probe exe');
    assert.ok(spec.probe.exe.length > 0);
    assert.ok(Array.isArray(spec.probe.args), spec.id + ' probe args is an array');
    for (const arg of spec.probe.args) assert.equal(typeof arg, 'string', spec.id + ' probe arg is a string');
    if (spec.probe.match !== undefined) assert.equal(typeof spec.probe.match, 'string', spec.id + ' probe match');
  }
});

test('catalog: requires names only engines that exist', function () {
  for (const spec of ENGINES) {
    for (const dependency of spec.requires || []) {
      assert.ok(byId(dependency) !== undefined, spec.id + ' requires known engine ' + dependency);
      assert.notEqual(dependency, spec.id, spec.id + ' does not require itself');
    }
  }
});

test('catalog: forPlatform keeps unsupported entries so the UI can explain them', function () {
  const win = forPlatform('win32');
  assert.equal(win.length, ENGINES.length, 'every catalog entry applies to win32');
  assert.deepEqual(forPlatform('linux'), [], 'no catalog entry claims Linux');
  assert.deepEqual(forPlatform('darwin'), [], 'no catalog entry claims macOS');
  assert.equal(forPlatform().length, ENGINES.length, 'defaulting to the host keeps entries');
});

test('catalog: installableEngines excludes the unsupported lanes', function () {
  const installable = installableEngines('win32');
  const ids = installable.map(function id(spec) {
    return spec.id;
  });
  assert.deepEqual(ids, ['adb', 'apktool', 'jadx', 'wabt', 'python', 'frida', 'dotnet', 'mitmproxy']);
  for (const spec of installable) assert.equal(spec.hostUnsupported, undefined);
});

test('catalog: byId answers undefined for junk instead of throwing', function () {
  assert.equal(byId('nope'), undefined);
  assert.equal(byId(''), undefined);
  assert.equal(byId(null), undefined);
  assert.equal(byId(undefined), undefined);
  assert.equal(byId(42), undefined);
  assert.equal(byId('jadx').id, 'jadx');
});

test('catalog: envVarNames is stable, unique and includes the external pair', function () {
  const names = envVarNames();
  assert.ok(Array.isArray(names));
  assert.equal(new Set(names).size, names.length, 'no duplicates');
  assert.ok(names.includes('JAVA_HOME'));
  assert.ok(names.includes('GHIDRA_INSTALL_DIR'));
  assert.ok(names.includes('REA_ADB_PATH'));
  assert.ok(!names.includes('REA_POWERPACK_HOME'), 'the powerpack home is not an engine variable');
});
