import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATE_VERSION, TOMBSTONE_TTL_MS, VersionError,
  emptyState, merge, prune, setHidden,
} from '../extension/lib/merge.js';

const st = (orders) => ({ version: STATE_VERSION, orders });

test('emptyState has the current version and no orders', () => {
  assert.deepEqual(emptyState(), { version: STATE_VERSION, orders: {} });
});

test('merge takes the union of disjoint states', () => {
  const a = st({ 'a-1': { hidden: true, ts: 100 } });
  const b = st({ 'b-2': { hidden: true, ts: 200 } });
  assert.deepEqual(merge(a, b).orders, {
    'a-1': { hidden: true, ts: 100 },
    'b-2': { hidden: true, ts: 200 },
  });
});

test('merge is commutative, associative and idempotent', () => {
  const a = st({ x: { hidden: true, ts: 100 }, y: { hidden: false, ts: 400 } });
  const b = st({ x: { hidden: false, ts: 200 }, z: { hidden: true, ts: 300 } });
  const c = st({ y: { hidden: true, ts: 500 }, z: { hidden: false, ts: 100 } });

  assert.deepEqual(merge(a, b), merge(b, a), 'commutative');
  assert.deepEqual(merge(merge(a, b), c), merge(a, merge(b, c)), 'associative');
  assert.deepEqual(merge(merge(a, b), b), merge(a, b), 'idempotent');
});

test('the higher timestamp wins regardless of argument order', () => {
  const older = st({ x: { hidden: true, ts: 100 } });
  const newer = st({ x: { hidden: false, ts: 200 } });
  assert.deepEqual(merge(older, newer).orders.x, { hidden: false, ts: 200 });
  assert.deepEqual(merge(newer, older).orders.x, { hidden: false, ts: 200 });
});

test('an exact timestamp tie resolves to hidden, in both orders', () => {
  const yes = st({ x: { hidden: true, ts: 100 } });
  const no = st({ x: { hidden: false, ts: 100 } });
  assert.equal(merge(yes, no).orders.x.hidden, true);
  assert.equal(merge(no, yes).orders.x.hidden, true);
});

test('a tombstone survives merging with a state that lacks the key', () => {
  // Without this, a device that never saw the order would resurrect it.
  const withTombstone = st({ x: { hidden: false, ts: 100 } });
  assert.deepEqual(merge(withTombstone, emptyState()).orders.x, { hidden: false, ts: 100 });
  assert.deepEqual(merge(emptyState(), withTombstone).orders.x, { hidden: false, ts: 100 });
});

test('merge refuses a state from a newer schema version', () => {
  const future = { version: STATE_VERSION + 1, orders: {} };
  assert.throws(() => merge(emptyState(), future), VersionError);
  assert.throws(() => merge(future, emptyState()), VersionError);
});

test('merge tolerates a state with no version field', () => {
  assert.deepEqual(merge({ orders: { x: { hidden: true, ts: 1 } } }, emptyState()).orders.x,
    { hidden: true, ts: 1 });
});

test('prune drops tombstones strictly older than the TTL', () => {
  const now = 1_000_000_000_000;
  const state = st({
    keep: { hidden: false, ts: now - TOMBSTONE_TTL_MS },       // exactly TTL: kept
    drop: { hidden: false, ts: now - TOMBSTONE_TTL_MS - 1 },   // TTL + 1ms: dropped
  });
  const out = prune(state, now);
  assert.ok('keep' in out.orders);
  assert.ok(!('drop' in out.orders));
});

test('prune never drops hidden entries no matter how old', () => {
  const now = 1_000_000_000_000;
  const state = st({ ancient: { hidden: true, ts: 0 } });
  assert.deepEqual(prune(state, now).orders.ancient, { hidden: true, ts: 0 });
});

test('setHidden records the flag and timestamp without mutating the input', () => {
  const before = st({ x: { hidden: true, ts: 100 } });
  const after = setHidden(before, 'y', true, 500);
  assert.deepEqual(after.orders.y, { hidden: true, ts: 500 });
  assert.deepEqual(before.orders, { x: { hidden: true, ts: 100 } }, 'input untouched');
});

test('setHidden overwrites an existing entry', () => {
  const state = setHidden(st({ x: { hidden: true, ts: 100 } }), 'x', false, 900);
  assert.deepEqual(state.orders.x, { hidden: false, ts: 900 });
});
