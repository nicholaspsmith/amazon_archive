import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, KV_KEY } from '../worker/src/handler.js';
import { STATE_VERSION, TOMBSTONE_TTL_MS } from '../extension/lib/merge.js';

const TOKEN = 'test-token';

function fakeKV(initial = {}) {
  const data = { ...initial };
  return {
    async get(key) { return key in data ? data[key] : null; },
    async put(key, value) { data[key] = value; },
    peek: () => data,
  };
}

const envWith = (kv) => ({ ORDERS: kv, AUTH_TOKEN: TOKEN });

const req = (method, path, { token, body } = {}) =>
  new Request(`https://w.example${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

test('rejects a request with no Authorization header', async () => {
  const res = await handleRequest(req('GET', '/list'), envWith(fakeKV()));
  assert.equal(res.status, 401);
});

test('rejects a wrong token', async () => {
  const res = await handleRequest(req('GET', '/list', { token: 'nope' }), envWith(fakeKV()));
  assert.equal(res.status, 401);
});

test('rejects every token when the secret is unset', async () => {
  const res = await handleRequest(req('GET', '/list', { token: '' }), { ORDERS: fakeKV() });
  assert.equal(res.status, 401);
});

test('answers preflight without requiring auth', async () => {
  const res = await handleRequest(req('OPTIONS', '/sync'), envWith(fakeKV()));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('GET /list returns an empty state when nothing is stored', async () => {
  const res = await handleRequest(req('GET', '/list', { token: TOKEN }), envWith(fakeKV()));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: STATE_VERSION, orders: {} });
});

test('GET /list does not write to KV', async () => {
  const kv = fakeKV();
  await handleRequest(req('GET', '/list', { token: TOKEN }), envWith(kv));
  assert.deepEqual(kv.peek(), {});
});

test('POST /sync returns the union of stored and incoming state', async () => {
  const kv = fakeKV({
    [KV_KEY]: JSON.stringify({ version: STATE_VERSION, orders: { 'a-1': { hidden: true, ts: 100 } } }),
  });
  const res = await handleRequest(
    req('POST', '/sync', { token: TOKEN, body: { version: STATE_VERSION, orders: { 'b-2': { hidden: true, ts: 200 } } } }),
    envWith(kv),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body.orders).sort(), ['a-1', 'b-2']);
});

test('POST /sync persists the merged result', async () => {
  const kv = fakeKV();
  await handleRequest(
    req('POST', '/sync', { token: TOKEN, body: { version: STATE_VERSION, orders: { 'a-1': { hidden: true, ts: 100 } } } }),
    envWith(kv),
  );
  assert.deepEqual(JSON.parse(kv.peek()[KV_KEY]).orders['a-1'], { hidden: true, ts: 100 });
});

test('POST /sync lets the newer timestamp win server-side', async () => {
  // Timestamps must be realistic here: the worker prunes against its own
  // Date.now(), so a tombstone stamped near the epoch would be expired before
  // the response is built.
  const now = Date.now();
  const kv = fakeKV({
    [KV_KEY]: JSON.stringify({ version: STATE_VERSION, orders: { x: { hidden: true, ts: now - 2000 } } }),
  });
  const res = await handleRequest(
    req('POST', '/sync', { token: TOKEN, body: { version: STATE_VERSION, orders: { x: { hidden: false, ts: now - 1000 } } } }),
    envWith(kv),
  );
  assert.equal((await res.json()).orders.x.hidden, false);
});

test('POST /sync prunes tombstones that have outlived the TTL', async () => {
  const kv = fakeKV();
  const ancient = Date.now() - TOMBSTONE_TTL_MS - 60_000;
  const res = await handleRequest(
    req('POST', '/sync', {
      token: TOKEN,
      body: { version: STATE_VERSION, orders: { old: { hidden: false, ts: ancient } } },
    }),
    envWith(kv),
  );
  assert.deepEqual((await res.json()).orders, {});
  assert.deepEqual(JSON.parse(kv.peek()[KV_KEY]).orders, {});
});

test('POST /sync refuses a newer schema version and leaves storage untouched', async () => {
  const kv = fakeKV();
  const res = await handleRequest(
    req('POST', '/sync', { token: TOKEN, body: { version: STATE_VERSION + 1, orders: {} } }),
    envWith(kv),
  );
  assert.equal(res.status, 409);
  assert.deepEqual(kv.peek(), {});
});

test('POST /sync rejects malformed bodies', async () => {
  const kv = fakeKV();
  for (const body of [{ orders: null }, { orders: 'nope' }, {}]) {
    const res = await handleRequest(req('POST', '/sync', { token: TOKEN, body }), envWith(kv));
    assert.equal(res.status, 400, `should reject ${JSON.stringify(body)}`);
  }
});

test('recovers from corrupt stored JSON instead of failing the request', async () => {
  const kv = fakeKV({ [KV_KEY]: 'not json{' });
  const res = await handleRequest(req('GET', '/list', { token: TOKEN }), envWith(kv));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { version: STATE_VERSION, orders: {} });
});

test('unknown routes return 404 for an authenticated caller', async () => {
  const res = await handleRequest(req('GET', '/nope', { token: TOKEN }), envWith(fakeKV()));
  assert.equal(res.status, 404);
});
