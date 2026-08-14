import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../extension/lib/store.js';
import { STATE_VERSION, TOMBSTONE_TTL_MS } from '../extension/lib/merge.js';

// Minimal stand-in for chrome.storage.local.
function fakeArea(initial = {}) {
  let data = { ...initial };
  return {
    async get(key) {
      if (key === null || key === undefined) return { ...data };
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { data = { ...data, ...obj }; },
    peek: () => data,
  };
}

test('load returns an empty state when storage is empty', async () => {
  const store = createStore(fakeArea());
  assert.deepEqual(await store.load(), { version: STATE_VERSION, orders: {} });
});

test('setHidden persists the entry and returns the new state', async () => {
  const area = fakeArea();
  const store = createStore(area);
  const state = await store.setHidden('123-4567890-1234567', true, 500);
  assert.deepEqual(state.orders['123-4567890-1234567'], { hidden: true, ts: 500 });
  assert.deepEqual(area.peek().state.orders['123-4567890-1234567'], { hidden: true, ts: 500 });
});

test('setHidden round-trips through load', async () => {
  const store = createStore(fakeArea());
  await store.setHidden('a-1', true, 500);
  const loaded = await store.load();
  assert.deepEqual(loaded.orders['a-1'], { hidden: true, ts: 500 });
});

test('save prunes expired tombstones before writing', async () => {
  const area = fakeArea();
  const store = createStore(area);
  const now = 1_000_000_000_000;
  await store.save({
    version: STATE_VERSION,
    orders: { stale: { hidden: false, ts: now - TOMBSTONE_TTL_MS - 1 } },
  }, now);
  assert.deepEqual(area.peek().state.orders, {});
});

test('applyRemote merges rather than overwriting local state', async () => {
  const area = fakeArea();
  const store = createStore(area);
  await store.setHidden('local-1', true, 100);

  const merged = await store.applyRemote({
    version: STATE_VERSION,
    orders: { 'remote-1': { hidden: true, ts: 200 } },
  }, 300);

  assert.deepEqual(Object.keys(merged.orders).sort(), ['local-1', 'remote-1']);
});

test('applyRemote lets a newer remote unhide beat an older local hide', async () => {
  const store = createStore(fakeArea());
  await store.setHidden('x-1', true, 100);
  const merged = await store.applyRemote({
    version: STATE_VERSION,
    orders: { 'x-1': { hidden: false, ts: 200 } },
  }, 300);
  assert.equal(merged.orders['x-1'].hidden, false);
});

test('meta defaults are null and survive a partial patch', async () => {
  const store = createStore(fakeArea());
  assert.deepEqual(await store.loadMeta(), { lastSyncAt: null, lastError: null });
  await store.saveMeta({ lastSyncAt: 42 });
  await store.saveMeta({ lastError: 'boom' });
  assert.deepEqual(await store.loadMeta(), { lastSyncAt: 42, lastError: 'boom' });
});

test('config defaults to empty strings and round-trips', async () => {
  const store = createStore(fakeArea());
  assert.deepEqual(await store.loadConfig(), { url: '', token: '' });
  await store.saveConfig({ url: 'https://x.workers.dev', token: 't' });
  assert.deepEqual(await store.loadConfig(), { url: 'https://x.workers.dev', token: 't' });
});
