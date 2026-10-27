import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_VERSION, ENGINES, forPlatform, installableEngines } from '../lib/catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (relative) => readFileSync(join(root, relative), 'utf8');

test('docs: the promised documents exist and are not stubs', () => {
  for (const file of ['README.md', 'docs/ENGINES.md', 'docs/UPDATES.md', 'docs/TROUBLESHOOTING.md']) {
    const path = join(root, file);
    assert.equal(existsSync(path), true, file + ' must exist');
    const text = readFileSync(path, 'utf8');
    assert.ok(text.length > 1500, file + ' is a real document, got ' + text.length + ' bytes');
  }
});

test('docs: README covers every section the contract asks for', () => {
  const text = read('README.md');
  const sections = ['亮点', '安装', '首次配置', '引擎矩阵', '更新与回滚', '故障排查', '开发与测试', '许可'];
  for (const title of sections) {
    assert.ok(new RegExp('^## ' + title, 'm').test(text), 'README has a "## " + title + " section');
  }
});

test('docs: every npm script named in the docs exists in package.json', () => {
  const manifest = JSON.parse(read('package.json'));
  const scripts = Object.keys(manifest.scripts || {});
  const sources = ['README.md', 'docs/ENGINES.md', 'docs/UPDATES.md', 'docs/TROUBLESHOOTING.md', 'ARCHITECTURE.md'];
  const mentioned = new Set();
  for (const file of sources) {
    const text = read(file);
    const runPattern = /\bnpm run ([A-Za-z0-9:_-]+)/g;
    let match = runPattern.exec(text);
    while (match !== null) {
      mentioned.add(match[1]);
      match = runPattern.exec(text);
    }
    if (/\bnpm test\b/.test(text)) mentioned.add('test');
  }
  assert.ok(mentioned.size > 0, 'the docs show how to run the suite');
  for (const name of mentioned) {
    assert.ok(scripts.includes(name), 'npm script declared in package.json: ' + name);
  }
});

test('docs: README documents the shipped test and lint commands', () => {
  const text = read('README.md');
  const manifest = JSON.parse(read('package.json'));
  // Contract §8 says `node --test test/`; Node >= 22 does not accept a bare directory
  // as a test entry, so the shipped script uses an equivalent glob. Accept both.
  assert.ok(
    manifest.scripts.test === 'node --test test/' || manifest.scripts.test === 'node --test "test/*.test.mjs"',
    'unexpected test script: ' + manifest.scripts.test,
  );
  assert.match(text, /npm test/);
  assert.match(text, /npm run lint/);
  assert.match(text, /npm run check:client/);
});

test('docs: engine matrix lists every catalog engine exactly once', () => {
  const text = read('docs/ENGINES.md');
  for (const spec of ENGINES) {
    const occurrences = text.split('`' + spec.id + '`').length - 1;
    assert.ok(occurrences >= 1, 'docs/ENGINES.md lists ' + spec.id);
  }
  const matrixRows = text.split('\n').filter((line) => /^\| `[a-z0-9-]+` \|/.test(line));
  assert.ok(matrixRows.length >= ENGINES.length, 'the matrix has a row per engine, got ' + matrixRows.length);
});

test('docs: README matrix and engine counts match the catalog', () => {
  const text = read('README.md');
  const managed = installableEngines('win32');
  assert.ok(managed.length > 0);
  for (const spec of managed) {
    assert.ok(text.includes('`' + spec.id + '`'), 'README mentions managed engine ' + spec.id);
  }
  const unsupported = forPlatform('win32').filter((spec) => spec.hostUnsupported === 'win32');
  assert.ok(text.includes(String(unsupported.length)), 'README states the number of unsupported lanes: ' + unsupported.length);
  assert.equal(CATALOG_VERSION, 1);
});

test('docs: every engine id named in the ARCHITECTURE §5 catalog list is documented', () => {
  const architecture = read('ARCHITECTURE.md');
  const enginesDoc = read('docs/ENGINES.md');
  const ids = Array.from(architecture.matchAll(/`([a-z0-9-]+)`\s*\(T[0-2]/g)).map((match) => match[1]);
  for (const id of ids) {
    assert.ok(enginesDoc.includes('`' + id + '`'), 'ENGINES.md documents the contract engine ' + id);
  }
});

test('docs: CI workflow runs the matrix on Node 22 and 24', () => {
  const path = join(root, '.github', 'workflows', 'ci.yml');
  assert.equal(existsSync(path), true, 'the CI workflow exists');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /node: \['22', '24'\]/);
  assert.match(text, /npm test/);
  assert.match(text, /npm run lint/);
  assert.match(text, /runs-on: ubuntu-latest/);
});

test('docs: the cross-references between documents resolve', () => {
  const files = ['README.md', 'docs/ENGINES.md', 'docs/UPDATES.md', 'docs/TROUBLESHOOTING.md'];
  for (const file of files) {
    const text = read(file);
    const pattern = /\]\(([^)]+)\)/g;
    let match = pattern.exec(text);
    while (match !== null) {
      const target = match[1].split('#')[0];
      if (target === '' || /^https?:/.test(target)) {
        match = pattern.exec(text);
        continue;
      }
      const resolved = join(dirname(join(root, file)), target);
      assert.equal(existsSync(resolved), true, file + ' links to a real file: ' + target);
      match = pattern.exec(text);
    }
  }
});

test('docs: ARCHITECTURE stays the contract and is referenced by the README', () => {
  assert.equal(existsSync(join(root, 'ARCHITECTURE.md')), true);
  assert.match(read('README.md'), /ARCHITECTURE\.md/);
});
