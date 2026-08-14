import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCloud, backoffDelay,
  NotConfiguredError, AuthError, VersionMismatchError, NetworkError,
} from '../extension/lib/cloud.js';

const CONFIG = { url: 'https://w.example', token: 'tok' };
const STATE = { version: 1, orders: {} };

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('backoffDelay doubles from 2s and caps at 5 minutes', () => {
  assert.equal(backoffDelay(0), 2000);
  assert.equal(backoffDelay(1), 4000);
  assert.equal(backoffDelay(2), 8000);
  assert.equal(backoffDelay(20), 300000);
});

test('list rejects when the url or token is missing', async () => {
  const cloud = createCloud({ fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(() => cloud.list({ url: '', token: 't' }), NotConfiguredError);
  await assert.rejects(() => cloud.list({ url: 'https://w.example', token: '' }), NotConfiguredError);
});

test('list issues an authorized GET to /list', async () => {
  let seen;
  const cloud = createCloud({
    fetchImpl: async (url, init) => { seen = { url, init }; return jsonResponse(STATE); },
  });
  await cloud.list(CONFIG);
  assert.equal(seen.url, 'https://w.example/list');
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
});

test('list tolerates a trailing slash on the configured url', async () => {
  let seen;
  const cloud = createCloud({
    fetchImpl: async (url) => { seen = url; return jsonResponse(STATE); },
  });
  await cloud.list({ url: 'https://w.example/', token: 'tok' });
  assert.equal(seen, 'https://w.example/list');
});

test('sync posts the state and returns the merged body', async () => {
  let seen;
  const merged = { version: 1, orders: { 'a-1': { hidden: true, ts: 1 } } };
  const cloud = createCloud({
    fetchImpl: async (url, init) => { seen = { url, init }; return jsonResponse(merged); },
  });
  const out = await cloud.sync(CONFIG, STATE);
  assert.equal(seen.url, 'https://w.example/sync');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), STATE);
  assert.deepEqual(out, merged);
});

test('a 401 becomes AuthError', async () => {
  const cloud = createCloud({ fetchImpl: async () => new Response(null, { status: 401 }) });
  await assert.rejects(() => cloud.list(CONFIG), AuthError);
});

test('a 409 becomes VersionMismatchError', async () => {
  const cloud = createCloud({ fetchImpl: async () => jsonResponse({ error: 'nope' }, 409) });
  await assert.rejects(() => cloud.sync(CONFIG, STATE), VersionMismatchError);
});

test('a 500 becomes NetworkError', async () => {
  const cloud = createCloud({ fetchImpl: async () => new Response(null, { status: 500 }) });
  await assert.rejects(() => cloud.list(CONFIG), NetworkError);
});

test('a thrown fetch becomes NetworkError', async () => {
  const cloud = createCloud({ fetchImpl: async () => { throw new TypeError('offline'); } });
  await assert.rejects(() => cloud.list(CONFIG), NetworkError);
});

test('an unparseable success body becomes NetworkError', async () => {
  const cloud = createCloud({
    fetchImpl: async () => new Response('<html>', { status: 200 }),
  });
  await assert.rejects(() => cloud.list(CONFIG), NetworkError);
});

test('a success body without an orders object becomes NetworkError', async () => {
  const cloud = createCloud({ fetchImpl: async () => jsonResponse({ nope: true }) });
  await assert.rejects(() => cloud.list(CONFIG), NetworkError);
});
