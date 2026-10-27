import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const indexFile = join(root, 'lib', 'index.js');
const missing = !existsSync(indexFile)
  ? 'lib/index.js is not implemented yet; the HTTP routes are tested once core lands'
  : false;

/** A fake http res that records status, headers and the JSON body. */
function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    finished: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    writeHead(code, headers) {
      this.statusCode = code;
      if (headers && typeof headers === 'object') {
        for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
      }
      return this;
    },
    write(chunk) {
      this.chunks.push(Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.from(String(chunk)));
      this.finished = true;
      return this;
    },
    get body() {
      return Buffer.concat(this.chunks).toString('utf8');
    },
    get json() {
      return JSON.parse(this.body);
    },
  };
}

/** A fake http req backed by a Readable so both events and for-await work. */
function makeRequest(method, url, options = {}) {
  const body = options.body === undefined ? '' : String(options.body);
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body)]);
  stream.method = method;
  stream.url = url;
  stream.headers = Object.assign(
    {
      host: '127.0.0.1:59739',
      'content-type': options.contentType || 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
    options.headers || {},
  );
  stream.socket = {
    remoteAddress: options.remoteAddress || '127.0.0.1',
    localAddress: '127.0.0.1',
  };
  stream.connection = stream.socket;
  return stream;
}

async function loadPlugin() {
  const module = await import(pathToFileURL(indexFile).href);
  return module;
}

/**
 * Boot the plugin host half against a throwaway powerpack home and hand back
 * the registered prepare function. Everything the test creates is disposed.
 */
async function boot(t) {
  const home = await mkdtemp(join(tmpdir(), 'rea-powerpack-http-'));
  const previousHome = process.env.REA_POWERPACK_HOME;
  process.env.REA_POWERPACK_HOME = home;
  const registration = { spec: null };
  const disposers = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    on() {
      return () => {};
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    webServer: {
      register(spec) {
        registration.spec = spec;
        return () => {};
      },
    },
    loader: {
      entries() {
        return [];
      },
      async update() {},
    },
    get() {
      return undefined;
    },
    set() {},
  };

  t.after(async () => {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch {
        /* best effort */
      }
    }
    if (previousHome === undefined) delete process.env.REA_POWERPACK_HOME;
    else process.env.REA_POWERPACK_HOME = previousHome;
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });

  const plugin = await loadPlugin();
  assert.equal(plugin.name, 'dsh-rea-powerpack');
  assert.ok(Array.isArray(plugin.inject));
  plugin.apply(ctx);
  return { home, registration, ctx, plugin };
}

async function call(registration, method, url, options = {}) {
  const handler = registration.spec.handler;
  const req = makeRequest(method, url, options);
  const res = makeResponse();
  await handler(req, res);
  return res;
}

test('http: apply registers one prefix route at /rea-powerpack', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  assert.ok(registration.spec !== null, 'webServer.register was called');
  assert.equal(registration.spec.kind, 'prefix');
  assert.equal(registration.spec.path, '/rea-powerpack');
  assert.equal(typeof registration.spec.handler, 'function');
});

test('http: GET /state returns the documented snapshot', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  const res = await call(registration, 'GET', '/rea-powerpack/state');
  assert.equal(res.statusCode, 200);
  assert.match(String(res.getHeader('content-type')), /application\/json/);
  const body = res.json;
  assert.ok(body && typeof body === 'object');
  assert.ok(body.self && typeof body.self === 'object', 'self describes the plugin');
  assert.equal(typeof body.profileDir, 'string');
  assert.equal(typeof body.writable, 'boolean');
  assert.ok(body.rea && typeof body.rea === 'object');
  assert.ok(Array.isArray(body.engines), 'engines is an array');
  assert.ok(body.settings && typeof body.settings === 'object');
  assert.ok(body.mcp && typeof body.mcp === 'object');
  assert.equal(typeof body.mcp.present, 'boolean');
  assert.ok(body.doctor && typeof body.doctor === 'object');
  assert.ok(body.host && typeof body.host === 'object');
  assert.equal(body.host.platform, process.platform);
  assert.equal(body.settings.updatePolicy, 'notify');
});

test('http: a non-loopback request is refused with loopback_only', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  for (const remoteAddress of ['10.1.2.3', '192.168.1.9', '::ffff:10.0.0.7', 'fe80::1']) {
    const res = await call(registration, 'GET', '/rea-powerpack/state', { remoteAddress });
    assert.equal(res.statusCode, 403, 'remote ' + remoteAddress + ' is refused');
    const body = res.json;
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'loopback_only');
    assert.equal(typeof body.error.message, 'string');
  }
});

test('http: IPv6 and IPv4-mapped loopback are allowed', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  for (const remoteAddress of ['::1', '::ffff:127.0.0.1']) {
    const res = await call(registration, 'GET', '/rea-powerpack/state', { remoteAddress });
    assert.equal(res.statusCode, 200, 'loopback ' + remoteAddress + ' is allowed');
  }
});

test('http: an unknown route is a stable 404', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  const res = await call(registration, 'GET', '/rea-powerpack/nope');
  assert.equal(res.statusCode, 404);
  const body = res.json;
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'not_found');
});

test('http: a request outside the prefix is not answered', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  const res = await call(registration, 'GET', '/other/state');
  assert.ok([404, 400].includes(res.statusCode), 'a foreign path is refused, got ' + res.statusCode);
  if (res.body !== '') {
    assert.equal(res.json.ok, false);
    assert.equal(typeof res.json.error.code, 'string');
  }
});

test('http: malformed JSON is bad_json', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  const res = await call(registration, 'POST', '/rea-powerpack/settings', { body: '{ nope' });
  assert.ok(res.statusCode >= 400 && res.statusCode < 500, 'client error, got ' + res.statusCode);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, 'bad_json');
});

test('http: a bad pin version is rejected with a stable code', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  const res = await call(registration, 'POST', '/rea-powerpack/pin', { body: JSON.stringify({ version: 'latest' }) });
  assert.ok(res.statusCode >= 400 && res.statusCode < 500, 'client error, got ' + res.statusCode);
  assert.equal(res.json.ok, false);
  assert.ok(['bad_request', 'no_such_version', 'registry_timeout', 'registry_unreachable', 'rea_missing'].includes(res.json.error.code), 'stable error code, got ' + res.json.error.code);
});

test('http: settings accepts a valid partial patch', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  const res = await call(registration, 'POST', '/rea-powerpack/settings', { body: JSON.stringify({ updatePolicy: 'manual' }) });
  assert.equal(res.statusCode, 200);
  const body = res.json;
  assert.equal(body.ok, true);
  const settings = body.settings || body.data || body.value;
  assert.ok(settings && typeof settings === 'object', 'the response carries the settings');
  assert.equal(settings.updatePolicy, 'manual');

  const state = await call(registration, 'GET', '/rea-powerpack/state');
  assert.equal(state.json.settings.updatePolicy, 'manual', 'the change is persisted and visible');
});

test('http: every error uses the shared {ok:false,error:{code,message}} envelope', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  const responses = [
    await call(registration, 'GET', '/rea-powerpack/state', { remoteAddress: '8.8.8.8' }),
    await call(registration, 'GET', '/rea-powerpack/unknown-route'),
    await call(registration, 'POST', '/rea-powerpack/settings', { body: '[' }),
  ];
  for (const res of responses) {
    const body = res.json;
    assert.equal(body.ok, false);
    assert.equal(typeof body.error.code, 'string');
    assert.equal(typeof body.error.message, 'string');
    assert.ok(body.error.message.length > 0);
  }
});

test('http: GET /report answers markdown or a stable error', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  const res = await call(registration, 'GET', '/rea-powerpack/report');
  if (res.statusCode === 200) {
    assert.match(String(res.getHeader('content-type')), /text\/markdown/);
    assert.match(res.body, /dsh-rea-powerpack|REA/i);
  } else {
    assert.ok(res.statusCode >= 400, 'a failure is an error status');
    assert.equal(res.json.ok, false);
    assert.equal(typeof res.json.error.code, 'string');
  }
});

test('http: POST /update without a version is rejected before any install', { skip: missing }, async (t) => {
  const { registration } = await boot(t);
  const res = await call(registration, 'POST', '/rea-powerpack/update', { body: JSON.stringify({ version: 'not-semver' }) });
  assert.ok(res.statusCode >= 400 && res.statusCode < 500, 'client error, got ' + res.statusCode);
  assert.equal(res.json.ok, false);
  assert.ok(['bad_request', 'pin_conflict', 'rea_missing', 'no_such_version', 'preflight_failed'].includes(res.json.error.code), 'stable code, got ' + res.json.error.code);
});
