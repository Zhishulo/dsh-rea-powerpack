import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  compareVersions,
  isEntryPoint,
  minimumRequired,
  parseVersion,
  planReexec,
  readReaNodeRange,
  satisfiesRange,
  selectNode,
} from '../lib/rea-mcp.mjs';

const REA_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1';

test('rea-mcp: parseVersion reads dotted versions out of loose output', () => {
  assert.equal(parseVersion('v24.22.1').text, '24.22.1');
  assert.equal(parseVersion('v24.22.1').major, 24);
  assert.equal(parseVersion('no version here'), null);
  assert.equal(parseVersion(undefined), null);
});

test('rea-mcp: compareVersions orders major, minor and patch', () => {
  assert.equal(compareVersions('24.22.1', '24.22.1'), 0);
  assert.equal(compareVersions('24.21.0', '24.22.1'), -1);
  assert.equal(compareVersions('25.0.0', '24.22.1'), 1);
  assert.equal(compareVersions('24.22.1', '24.22'), 1);
});

test('rea-mcp: satisfiesRange evaluates every clause of REA engines.node', () => {
  assert.equal(satisfiesRange('22.23.5', REA_RANGE), true);
  assert.equal(satisfiesRange('22.23.4', REA_RANGE), true);
  assert.equal(satisfiesRange('24.22.1', REA_RANGE), true);
  assert.equal(satisfiesRange('24.21.0', REA_RANGE), false);
  assert.equal(satisfiesRange('25.0.0', REA_RANGE), false);
  assert.equal(satisfiesRange('26.12.1', REA_RANGE), true);
  assert.equal(satisfiesRange('27.0.0', REA_RANGE), true);
  assert.equal(satisfiesRange('24.21.0', '>=24.0.0 <25'), true);
  assert.equal(satisfiesRange('25.0.0', '>=24.0.0 <25'), false);
  assert.equal(satisfiesRange('1.2.3', '*'), true);
});

test('rea-mcp: minimumRequired reports the lowest floor for diagnostics', () => {
  assert.equal(minimumRequired(REA_RANGE), '22.23.4');
  assert.equal(minimumRequired('>=24.22.1'), '24.22.1');
  assert.equal(minimumRequired(''), null);
});

test('rea-mcp: selectNode returns the first satisfying candidate only', () => {
  const candidates = [
    { path: 'C:/nodejs/node.exe', version: '24.21.0' },
    { path: 'C:/other/node.exe', version: '24.22.1' },
    { path: 'C:/third/node.exe', version: '26.12.1' },
  ];
  assert.equal(selectNode(candidates, REA_RANGE).path, 'C:/other/node.exe');
  assert.equal(selectNode([], REA_RANGE), null);
  assert.equal(selectNode([{ path: 'x', version: null }], REA_RANGE), null);
  assert.equal(selectNode(null, REA_RANGE), null);
});

test('rea-mcp: planReexec skips when already re-executed or already satisfied', () => {
  const candidates = [{ path: 'C:/other/node.exe', version: '24.22.1' }];
  assert.deepEqual(
    planReexec({ REA_POWERPACK_EXEC: '1' }, 'v24.21.0', REA_RANGE, candidates),
    { action: 'continue', reason: 'already-reexecuted' },
  );
  assert.deepEqual(
    planReexec({}, 'v24.22.1', REA_RANGE, candidates),
    { action: 'continue', reason: 'satisfied' },
  );
});

test('rea-mcp: planReexec continues with a warning when no candidate qualifies', () => {
  const plan = planReexec({}, 'v24.21.0', REA_RANGE, [{ path: 'C:/x/node.exe', version: '24.21.0' }]);
  assert.equal(plan.action, 'continue');
  assert.equal(plan.reason, 'no-candidate');
  assert.match(plan.warn, /continuing anyway/);
});

test('rea-mcp: planReexec hands over to the first qualifying candidate', () => {
  const plan = planReexec({}, 'v24.21.0', REA_RANGE, [
    { path: 'C:/electron/node.exe', version: '24.21.0' },
    { path: 'C:/nodejs/node.exe', version: '24.22.1' },
  ]);
  assert.equal(plan.action, 'run');
  assert.equal(plan.candidate.path, 'C:/nodejs/node.exe');
});

test('rea-mcp: isEntryPoint only fires for a direct launch', () => {
  const self = resolve('/tmp/rea-mcp.mjs');
  assert.equal(isEntryPoint(['node', self], self), true);
  assert.equal(isEntryPoint(['node', resolve('/tmp/other.mjs')], self), false);
  assert.equal(isEntryPoint(['node'], self), false);
});

test('rea-mcp: readReaNodeRange falls back to the built-in floor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rea-powerpack-node-'));
  try {
    assert.equal(readReaNodeRange(dir), '>=24.22.1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
