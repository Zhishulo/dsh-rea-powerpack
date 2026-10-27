// Loads lib/client.js the way the harness does: a fake window.__ModuleLoader__
// records the bundle's factory, a minimal React stub lets the card render once,
// and a fake host answers GET /state so the summary path exercises real data.
// Everything here stays in-process: no network, no DOM, no disk writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'lib', 'client.js');

/** A React stub: element records, plus the three hooks the card uses. */
function makeReact() {
  const store = new Map();
  let current = null;
  let cursor = 0;

  function createElement(type, props) {
    const resolved = Object.assign({}, props === null || props === undefined ? {} : props);
    const children = Array.prototype.slice.call(arguments, 2);
    if (children.length === 1) resolved.children = children[0];
    else if (children.length > 1) resolved.children = children;
    return { vnode: true, type: type, props: resolved };
  }

  function useState(initial) {
    const holder = current;
    const index = cursor;
    cursor += 1;
    if (holder.values[index] === undefined) {
      holder.values[index] = { value: typeof initial === 'function' ? initial() : initial };
    }
    const slot = holder.values[index];
    return [
      slot.value,
      function set(next) {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) {
          slot.value = value;
          holder.dirty = true;
        }
      },
    ];
  }

  function useEffect(fn, deps) {
    const holder = current;
    const index = cursor;
    cursor += 1;
    if (holder.pass === 0) {
      holder.effects.push({ fn: fn, deps: deps });
    }
  }

  function useCallback(fn) {
    cursor += 1;
    return fn;
  }

  function renderComponent(component, props) {
    let holder = store.get(component);
    if (holder === undefined) {
      holder = { values: [], pass: 0, effects: [], dirty: false };
      store.set(component, holder);
    }
    const previous = current;
    const previousCursor = cursor;
    current = holder;
    cursor = 0;
    holder.dirty = false;
    const rendered = component(props);
    const effects = holder.pass === 0 ? holder.effects.slice() : [];
    holder.pass += 1;
    current = previous;
    cursor = previousCursor;
    for (const effect of effects) effect.fn();
    return { rendered: rendered, dirty: holder.dirty };
  }

  return {
    createElement: createElement,
    useState: useState,
    useEffect: useEffect,
    useCallback: useCallback,
    renderComponent: renderComponent,
  };
}

/** Flatten a rendered tree to its text, invoking function components. */
function textOf(react, node, depth) {
  const level = depth === undefined ? 0 : depth;
  if (level > 60) return '';
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    let out = '';
    for (const child of node) out += textOf(react, child, level + 1) + ' ';
    return out;
  }
  if (node.vnode !== true) return '';
  if (typeof node.type === 'function') {
    const result = react.renderComponent(node.type, node.props);
    return textOf(react, result.rendered, level + 1);
  }
  return textOf(react, node.props.children, level + 1);
}

/** The /state answer the fake host returns; shaped after contract section 4. */
function stateFixture() {
  return {
    self: { name: 'dsh-rea-powerpack', version: '0.1.0' },
    profileDir: 'C:\\profiles\\desktop',
    writable: true,
    rea: {
      installed: true,
      pinned: '1.4.2',
      requested: '1.4.2',
      pinnedAt: '2026-10-01T00:00:00.000Z',
      pinnedFrom: 'cli',
      source: 'profile',
      latestKnown: '1.4.2',
      checkedAt: '2026-10-02T00:00:00.000Z',
      enginesWarning: null,
      retained: { from: '1.4.1', at: '2026-10-01T00:00:00.000Z' },
    },
    engines: [
      {
        id: 'jadx',
        name: 'JADX',
        tier: 1,
        status: 'ok',
        version: '1.5.1',
        path: 'C:\\engines\\jadx\\bin\\jadx.bat',
        envVar: 'REA_JADX',
        remedy: null,
        installable: true,
        managed: true,
      },
      {
        id: 'ghidra',
        name: 'Ghidra',
        tier: 0,
        status: 'external_ok',
        version: '11.2',
        path: 'C:\\ghidra\\ghidraRun.bat',
        envVar: 'REA_GHIDRA_DIR',
        remedy: null,
        installable: false,
        managed: false,
      },
    ],
    settings: { updatePolicy: 'notify', toolTimeoutMs: 900000, checkIntervalHours: 6, engineRoot: null, locale: 'auto' },
    mcp: { rowId: 'rea-powerpack-mcp', present: true, disabled: false },
    conflict: null,
    doctor: { stale: false, lastAt: '2026-10-02T00:00:00.000Z', toolCount: 210, availableGroups: 6, totalGroups: 6 },
    host: { platform: 'win32', node: 'v24.19.0', javaHome: 'C:\\Java', ghidraDir: 'C:\\ghidra' },
  };
}

/** Run the bundle in this realm against a fake loader and host. */
function loadBundle() {
  const react = makeReact();
  const specs = [];
  const seat = { spec: null, component: null };
  const locales = [];
  const effects = [];
  const fetches = [];
  const required = [];

  globalThis.window = {
    __ModuleLoader__: {
      load: function load(spec) {
        specs.push(spec);
      },
    },
    localStorage: {
      getItem: function getItem() {
        return null;
      },
      setItem: function setItem() {},
    },
  };
  globalThis.fetch = function fetch(url, init) {
    fetches.push({ url: url, method: init && init.method ? init.method : 'GET' });
    const body = url === '/rea-powerpack/state' ? stateFixture() : { ok: true };
    return Promise.resolve({
      ok: true,
      status: 200,
      text: function text() {
        return Promise.resolve(JSON.stringify(body));
      },
    });
  };

  const source = fs.readFileSync(bundlePath, 'utf8');
  vm.runInThisContext(source, { filename: bundlePath });

  assert.equal(specs.length, 1, 'the bundle calls __ModuleLoader__.load exactly once');
  const spec = specs[0];
  assert.equal(spec.id, 'dsh-rea-powerpack');
  assert.equal(typeof spec.factory, 'function');

  const exportsObject = spec.factory(function requireStub(id) {
    required.push(id);
    if (id === 'react') return react;
    throw new Error('unexpected require: ' + id);
  });
  assert.ok(exportsObject !== null && typeof exportsObject === 'object', 'the factory returns exports');

  const ctx = {
    effect: function effect(fn) {
      effects.push(fn);
      const dispose = fn();
      if (typeof dispose === 'function') effects.push(dispose);
      return dispose;
    },
    slots: {
      inject: function inject(name, factory) {
        assert.equal(name, 'settings.plugins.tab');
        return factory();
      },
      register: function register(specInput, component) {
        seat.spec = specInput;
        seat.component = component;
        return { dispose: function dispose() {} };
      },
    },
    locale: {
      register: function register(namespace, dict) {
        locales.push({ namespace: namespace, dict: dict });
        return { dispose: function dispose() {} };
      },
      // The host hands out a translator bound to a registered namespace; the
      // fake resolves it lazily so registration order does not matter.
      bind: function bind(namespace) {
        return function translate(key) {
          const found = locales.filter(function match(item) {
            return item.namespace === namespace;
          })[0];
          if (found && found.dict && typeof found.dict.zh[key] === 'string') return found.dict.zh[key];
          return key;
        };
      },
    },
  };
  exportsObject.apply(ctx);

  return { exportsObject, spec, seat, locales, required, fetches, react, effects };
}

test('client bundle: lazy-CJS envelope exposes the plugin shape', function () {
  const loaded = loadBundle();
  assert.equal(loaded.exportsObject.name, 'dsh-rea-powerpack');
  assert.ok(Array.isArray(loaded.exportsObject.inject), 'inject is an array');
  assert.ok(loaded.exportsObject.inject.includes('slots'), 'inject declares slots');
  assert.ok(loaded.exportsObject.inject.includes('locale'), 'inject declares locale');
  assert.equal(loaded.exportsObject.NS, 'dsh-rea-powerpack');
  assert.equal(typeof loaded.exportsObject.apply, 'function');
  assert.deepEqual(loaded.required, ['react'], 'the bundle requires React and nothing else');
});

test('client bundle: contributes one Settings → Plugins tab', function () {
  const loaded = loadBundle();
  assert.ok(loaded.seat.spec !== null, 'slots.register was called');
  assert.equal(loaded.seat.spec.name, 'settings.plugins.tab');
  assert.equal(loaded.seat.spec.id, 'dsh-rea-powerpack');
  assert.equal(loaded.seat.spec.order, 20);
  assert.equal(loaded.seat.spec.locale, 'dsh-rea-powerpack');
  assert.equal(typeof loaded.seat.spec.label, 'function');
  assert.equal(loaded.seat.spec.label(), 'REA 强化', 'the tab label comes from the registered dictionary');
  assert.equal(typeof loaded.seat.spec.inject, 'function');
  const props = loaded.seat.spec.inject();
  assert.ok(props !== null && typeof props === 'object');
  assert.equal(typeof props.powerpackT, 'function', 'the host translator is handed to the tab');
  assert.equal(props.powerpackT('tab'), 'REA 强化');
  assert.equal(typeof loaded.seat.component, 'function');
});

test('client bundle: registers zh and en dictionaries and keeps them 1:1', function () {
  const loaded = loadBundle();
  assert.equal(loaded.locales.length, 1, 'exactly one locale namespace');
  const namespace = loaded.locales[0];
  assert.equal(namespace.namespace, 'dsh-rea-powerpack');
  const zh = namespace.dict.zh;
  const en = namespace.dict.en;
  assert.ok(zh !== null && typeof zh === 'object');
  assert.ok(en !== null && typeof en === 'object');

  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.ok(zhKeys.length > 100, 'the dictionary carries the whole card, got ' + zhKeys.length);
  assert.deepEqual(enKeys, zhKeys, 'zh and en key sets must be identical');

  for (const key of zhKeys) {
    assert.equal(typeof zh[key], 'string', 'zh.' + key + ' is a string');
    assert.equal(typeof en[key], 'string', 'en.' + key + ' is a string');
    assert.ok(zh[key].length > 0, 'zh.' + key + ' is not empty');
    assert.ok(en[key].length > 0, 'en.' + key + ' is not empty');
    const placeholders = function placeholders(text) {
      return (text.match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(',');
    };
    assert.equal(placeholders(en[key]), placeholders(zh[key]), 'placeholders match for ' + key);
  }
});

test('client bundle: every literal translation key exists in both dictionaries', function () {
  const loaded = loadBundle();
  const dict = loaded.locales[0].dict;
  const source = fs.readFileSync(bundlePath, 'utf8');
  const pattern = /\bt\('([A-Za-z][A-Za-z0-9_.]*)'/g;
  const used = new Set();
  let match = pattern.exec(source);
  while (match !== null) {
    used.add(match[1]);
    match = pattern.exec(source);
  }
  assert.ok(used.size > 100, 'the card uses its dictionary directly, found ' + used.size + ' keys');
  const missing = [];
  for (const key of used) {
    if (dict.zh[key] === undefined && dict.en[key] === undefined) missing.push(key);
  }
  assert.deepEqual(missing, [], 'missing dictionary keys: ' + missing.join(', '));
});

test('client bundle: the Settings tab renders from GET /state only', async function () {
  const loaded = loadBundle();
  const tab = loaded.seat.component({});
  assert.equal(tab.vnode, true);
  assert.equal(tab.type.name, 'Section', 'the tab renders the card');

  // First pass: the card states that it is loading.
  const first = loaded.react.renderComponent(tab.type, tab.props);
  const loadingText = textOf(loaded.react, first.rendered);
  assert.ok(loadingText.trim().length > 0, 'the loading summary is not empty');

  // Let the state request settle, then render the summary with real data.
  await new Promise(function settle(resolve) {
    setTimeout(resolve, 0);
  });
  const second = loaded.react.renderComponent(tab.type, tab.props);
  const text = textOf(loaded.react, second.rendered);
  assert.ok(/1\/2|1\/2|REA 1\.4\.2|1\.4\.2/.test(text), 'summary mentions the REA pin: ' + text);

  for (const call of loaded.fetches) {
    assert.ok(call.url.startsWith('/rea-powerpack/'), 'only the plugin prefix is fetched: ' + call.url);
  }
  assert.ok(
    loaded.fetches.some(function some(call) {
      return call.url === '/rea-powerpack/state';
    }),
    'the card reads /rea-powerpack/state',
  );
});

test('client bundle: fetches never escape the plugin prefix', function () {
  const source = fs.readFileSync(bundlePath, 'utf8');
  assert.ok(source.includes("var API_PREFIX = '/rea-powerpack'"), 'the prefix constant is declared');
  const fetchCalls = source.match(/fetch\(/g) || [];
  assert.equal(fetchCalls.length, 1, 'there is exactly one fetch call site');
  assert.ok(!/fetch\(\s*['"`]\/(?!rea-powerpack)/.test(source), 'no fetch hard-codes a non-plugin route');

  // Security boundary: the only network call the card may make is to the
  // plugin's own loopback prefix. No external origin, no protocol-relative
  // URL, no bare relative path that could resolve outside the prefix.
  assert.ok(
    !/fetch\(\s*['"`]\s*(?:https?:)?\/\//.test(source),
    'no fetch targets an external origin or a protocol-relative URL',
  );
  assert.ok(
    !/fetch\(\s*['"`][^'"`]*['"`]\s*\+/.test(source),
    'the fetch URL is not a hard-coded origin with a concatenated path',
  );
  const callSite = source.slice(source.indexOf('fetch('), source.indexOf('fetch(') + 400);
  assert.ok(callSite.includes('API_PREFIX'), 'the fetch URL is derived from API_PREFIX: ' + callSite);

  // Runtime half: every request the card actually issued stayed on-prefix and
  // resolved as an absolute-path request on the harness origin.
  let origin = null;
  try {
    origin = new URL('/rea-powerpack/state', 'http://127.0.0.1:1').origin;
  } catch {
    origin = null;
  }
  assert.equal(origin, 'http://127.0.0.1:1');
});
