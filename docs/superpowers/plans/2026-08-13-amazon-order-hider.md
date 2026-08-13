# Amazon Order Hider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A personal-use MV3 extension for Firefox and Chrome that restores order hiding on the amazon.com order history page, with the hidden-order list mirrored to a private Cloudflare Worker so it follows you between machines and browsers.

**Architecture:** Cards are hidden by injecting CSS attribute-suffix rules at `document_start` rather than by removing DOM nodes — hiding therefore lands before first paint and survives Amazon's own re-renders without racing them. State is a last-write-wins element set with tombstones, merged identically on the client and in the Worker, so concurrent edits on two devices combine instead of clobbering. `storage.local` is always the read path; the orders page never waits on the network.

**Tech Stack:** Vanilla ES2022, no framework, no bundler, no runtime dependencies. `node --test` for tests (Node ≥ 20). Cloudflare Workers + KV for sync, deployed with `npx wrangler`.

## Global Constraints

- Manifest V3, single manifest serving both Chrome and Firefox.
- Firefox requires `browser_specific_settings.gecko.id` = `amazon-order-hider@nicholassmith` and `strict_min_version` = `121.0`.
- **Zero runtime dependencies and zero build step.** `npm test` must work on a clean checkout with no `npm install`.
- Wrangler is invoked via `npx`, never added to `package.json`.
- The bearer token and Worker URL are never committed. They live in `storage.local`, entered via the options page.
- Only order IDs and timestamps ever leave the machine. No titles, prices, dates, addresses, or images are collected or transmitted.
- All injected DOM uses the `aa-` class/id prefix.
- State version is `1`. Any state carrying a higher `version` must be refused, never flattened.
- Tombstone TTL is 90 days exactly; `now - ts > TTL` is dropped, `now - ts === TTL` is kept.
- Two module conventions, deliberately:
  - `extension/lib/*.js` (except `rules.js`), `extension/background/`, `extension/popup/`, `extension/options/`, `worker/src/` — **ES modules with named exports**.
  - `extension/lib/rules.js` — **namespace-assignment style**, valid both as a classic content script and as a side-effect ESM import. It must contain no `import`/`export` statements and must not rely on `this`.
- The background script is the **only** writer to `storage.local` and the **only** caller of `fetch`. Content script and popup request changes by message and react to `storage.onChanged`.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | Test script only. No dependencies. |
| `extension/manifest.json` | MV3 manifest, both browsers. |
| `extension/lib/rules.js` | Pure DOM helpers: `orderIdFromSlotId`, `buildStyleText`, `hiddenIds`. Classic-script compatible. |
| `extension/lib/merge.js` | Pure LWW-set: `merge`, `prune`, `setHidden`, `emptyState`, `VersionError`. |
| `extension/lib/api.js` | `browser`/`chrome` namespace shim. |
| `extension/lib/store.js` | `createStore(area)` — the only `storage.local` accessor. |
| `extension/lib/cloud.js` | `createCloud({fetchImpl})` — Worker HTTP client, typed errors, `backoffDelay`. |
| `extension/background/worker.js` | Sync orchestration, message handling, alarms, debounce. |
| `extension/content/orders.js` | Style injection, button injection, reveal toggle. |
| `extension/content/orders.css` | Styling for injected UI. |
| `extension/popup/popup.{html,js,css}` | Hidden-order list, unhide, sync status. |
| `extension/options/options.{html,js}` | Worker URL + token, permission request, connection test. |
| `worker/src/handler.js` | `handleRequest(request, env)` — pure enough to unit test with a fake KV. |
| `worker/src/index.js` | Cloudflare entry point wrapping `handleRequest`. |
| `worker/wrangler.toml` | KV binding and worker name. No secrets. |
| `test/*.test.js` | `node --test` suites. |
| `docs/manual-verification.md` | Live-page checklist. |

---

## Task 1: Scaffolding and order-ID extraction

**Files:**
- Create: `package.json`
- Create: `extension/lib/rules.js`
- Test: `test/rules.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `globalThis.AA.orderIdFromSlotId(slotId: string) => string | null`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "amazon-order-hider",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/rules.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/lib/rules.js';

const { orderIdFromSlotId } = globalThis.AA;

test('extracts the order id from a well-formed slot id', () => {
  assert.equal(
    orderIdFromSlotId('amzn1.yourorders.order-card.123-4567890-1234567'),
    '123-4567890-1234567',
  );
});

test('extracts digital order ids that carry a letter prefix', () => {
  assert.equal(
    orderIdFromSlotId('amzn1.yourorders.order-card.D01-2345678-1234567'),
    'D01-2345678-1234567',
  );
});

test('rejects the content-id value, which shares the prefix but carries no id', () => {
  // data-csa-c-content-id sits on the same element as data-csa-c-slot-id.
  // Matching it would produce a selector that hides every order card.
  assert.equal(orderIdFromSlotId('amzn1.yourorders.order-card'), null);
});

test('rejects a trailing dot with no id after it', () => {
  assert.equal(orderIdFromSlotId('amzn1.yourorders.order-card.'), null);
});

test('rejects ids containing characters that could break out of a CSS selector', () => {
  for (const evil of [
    'amzn1.yourorders.order-card.111"] , * {display:block} [x="',
    'amzn1.yourorders.order-card.111]',
    'amzn1.yourorders.order-card.a b',
    'amzn1.yourorders.order-card.111.222',
  ]) {
    assert.equal(orderIdFromSlotId(evil), null, `should reject: ${evil}`);
  }
});

test('rejects unrelated and non-string input', () => {
  for (const bad of ['', 'amzn1.something.else.123', null, undefined, 42, {}]) {
    assert.equal(orderIdFromSlotId(bad), null);
  }
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module .../extension/lib/rules.js`

- [ ] **Step 4: Write the minimal implementation**

Create `extension/lib/rules.js`:

```js
// Namespace-assignment style: this file is loaded BOTH as a classic content
// script (listed in manifest content_scripts.js) and as a side-effect ESM
// import from tests and the popup. It must therefore contain no import/export
// statements and must not rely on `this`.
(function (root) {
  const SLOT_PREFIX = 'amzn1.yourorders.order-card.';

  // Order ids are interpolated into CSS attribute selectors, so the character
  // set is restricted to what cannot terminate a selector or start a new rule.
  const ID_PATTERN = /^[A-Za-z0-9-]+$/;

  function orderIdFromSlotId(slotId) {
    if (typeof slotId !== 'string') return null;
    if (!slotId.startsWith(SLOT_PREFIX)) return null;
    const id = slotId.slice(SLOT_PREFIX.length);
    return ID_PATTERN.test(id) ? id : null;
  }

  root.AA = Object.assign(root.AA || {}, { SLOT_PREFIX, orderIdFromSlotId });
})(globalThis);
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json extension/lib/rules.js test/rules.test.js
git commit -m "feat: extract order ids from card slot attributes"
```

---

## Task 2: Merge and prune

**Files:**
- Create: `extension/lib/merge.js`
- Test: `test/merge.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `STATE_VERSION: number` (= 1)
  - `TOMBSTONE_TTL_MS: number`
  - `class VersionError extends Error` with `.found`
  - `emptyState() => {version, orders: {}}`
  - `merge(a, b) => state`
  - `prune(state, now: number) => state`
  - `setHidden(state, id: string, hidden: boolean, now: number) => state`
  - State entry shape: `{ hidden: boolean, ts: number }`

- [ ] **Step 1: Write the failing test**

Create `test/merge.test.js`:

```js
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module .../extension/lib/merge.js`

- [ ] **Step 3: Write the minimal implementation**

Create `extension/lib/merge.js`:

```js
export const STATE_VERSION = 1;
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export class VersionError extends Error {
  constructor(found) {
    super(`state version ${found} is newer than supported version ${STATE_VERSION}`);
    this.name = 'VersionError';
    this.found = found;
  }
}

export function emptyState() {
  return { version: STATE_VERSION, orders: {} };
}

function ordersOf(state) {
  if (!state || typeof state !== 'object') throw new TypeError('state must be an object');
  const version = state.version ?? STATE_VERSION;
  if (version > STATE_VERSION) throw new VersionError(version);
  return state.orders ?? {};
}

// Later timestamp wins. An exact tie resolves to hidden so that the result does
// not depend on argument order, which is what makes merge commutative.
function pick(a, b) {
  if (!a) return { ...b };
  if (!b) return { ...a };
  if (a.ts > b.ts) return { ...a };
  if (b.ts > a.ts) return { ...b };
  return a.hidden ? { ...a } : { ...b };
}

export function merge(a, b) {
  const oa = ordersOf(a);
  const ob = ordersOf(b);
  const orders = {};
  for (const id of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
    orders[id] = pick(oa[id], ob[id]);
  }
  return { version: STATE_VERSION, orders };
}

// Tombstones exist so an unhide propagates instead of looking like "never
// hidden". They only need to outlive the slowest device, so they expire.
export function prune(state, now) {
  const source = ordersOf(state);
  const orders = {};
  for (const [id, entry] of Object.entries(source)) {
    if (entry.hidden === false && now - entry.ts > TOMBSTONE_TTL_MS) continue;
    orders[id] = { ...entry };
  }
  return { version: STATE_VERSION, orders };
}

export function setHidden(state, id, hidden, now) {
  return {
    version: STATE_VERSION,
    orders: { ...ordersOf(state), [id]: { hidden, ts: now } },
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm test`
Expected: PASS, 18 tests total.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/merge.js test/merge.test.js
git commit -m "feat: add last-write-wins merge with tombstones"
```

---

## Task 3: Style rule building and hidden-id listing

**Files:**
- Modify: `extension/lib/rules.js`
- Modify: `test/rules.test.js`

**Interfaces:**
- Consumes: `globalThis.AA.orderIdFromSlotId` (Task 1).
- Produces:
  - `globalThis.AA.hiddenIds(state) => string[]`
  - `globalThis.AA.buildStyleText(ids: string[]) => string`
  - `globalThis.AA.CARD_SELECTOR: string`

- [ ] **Step 1: Write the failing test**

Append to `test/rules.test.js`:

```js
const { hiddenIds, buildStyleText, CARD_SELECTOR } = globalThis.AA;

test('hiddenIds returns only entries flagged hidden', () => {
  const state = {
    version: 1,
    orders: {
      'a-1': { hidden: true, ts: 3 },
      'b-2': { hidden: false, ts: 4 },
      'c-3': { hidden: true, ts: 5 },
    },
  };
  assert.deepEqual(hiddenIds(state).sort(), ['a-1', 'c-3']);
});

test('hiddenIds tolerates missing and empty state', () => {
  assert.deepEqual(hiddenIds(undefined), []);
  assert.deepEqual(hiddenIds({}), []);
  assert.deepEqual(hiddenIds({ orders: {} }), []);
});

test('buildStyleText returns nothing when there is nothing to hide', () => {
  assert.equal(buildStyleText([]), '');
});

test('buildStyleText emits a suffix selector per id', () => {
  const css = buildStyleText(['123-4567890-1234567']);
  assert.match(css, /\[data-csa-c-slot-id\$="\.123-4567890-1234567"\]/);
  assert.match(css, /display:\s*none/);
});

test('buildStyleText emits a reveal rule gated on the aa-reveal class', () => {
  const css = buildStyleText(['123-4567890-1234567']);
  assert.match(css, /html\.aa-reveal/);
  assert.match(css, /opacity/);
});

test('buildStyleText skips ids that fail validation', () => {
  // Defence in depth: even if a bad id reaches storage, it must not reach CSS.
  const css = buildStyleText(['good-1', 'bad"] * {display:block} [x="']);
  assert.match(css, /good-1/);
  assert.doesNotMatch(css, /display:\s*block/);
});

test('CARD_SELECTOR matches the slot-id prefix', () => {
  assert.equal(CARD_SELECTOR, '[data-csa-c-slot-id^="amzn1.yourorders.order-card."]');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL — `TypeError: hiddenIds is not a function` (destructuring yields `undefined`).

- [ ] **Step 3: Write the minimal implementation**

In `extension/lib/rules.js`, add inside the IIFE, before the `root.AA` assignment:

```js
  const CARD_SELECTOR = `[data-csa-c-slot-id^="${SLOT_PREFIX}"]`;

  function hiddenIds(state) {
    const orders = (state && state.orders) || {};
    return Object.keys(orders).filter((id) => orders[id] && orders[id].hidden);
  }

  // Cards are hidden with CSS rather than removed from the DOM: the rule is in
  // place before first paint, and it keeps applying when Amazon re-renders the
  // list for pagination or filtering, with no observer racing the renderer.
  function buildStyleText(ids) {
    const safe = ids.filter((id) => ID_PATTERN.test(id));
    if (safe.length === 0) return '';
    const selector = safe.map((id) => `[data-csa-c-slot-id$=".${id}"]`).join(',\n');
    return [
      `${selector} { display: none !important; }`,
      '',
      `html.aa-reveal :is(${selector}) {`,
      '  display: block !important;',
      '  opacity: 0.45;',
      '  outline: 1px dashed #888;',
      '  outline-offset: 2px;',
      '}',
      '',
    ].join('\n');
  }
```

Then extend the namespace assignment:

```js
  root.AA = Object.assign(root.AA || {}, {
    SLOT_PREFIX, CARD_SELECTOR, orderIdFromSlotId, hiddenIds, buildStyleText,
  });
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm test`
Expected: PASS, 25 tests total.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/rules.js test/rules.test.js
git commit -m "feat: build hide and reveal CSS from the hidden id set"
```

---

## Task 4: Namespace shim and local store

**Files:**
- Create: `extension/lib/api.js`
- Create: `extension/lib/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: `merge`, `prune`, `setHidden`, `emptyState` (Task 2).
- Produces: `createStore(area)` returning an object with
  - `load() => Promise<state>`
  - `save(state, now?) => Promise<state>` (prunes before writing, returns what was written)
  - `setHidden(id, hidden, now?) => Promise<state>`
  - `applyRemote(remote, now?) => Promise<state>` (merges remote into local)
  - `loadMeta() => Promise<{lastSyncAt: number|null, lastError: string|null}>`
  - `saveMeta(patch) => Promise<meta>`
  - `loadConfig() => Promise<{url: string, token: string}>`
  - `saveConfig({url, token}) => Promise<void>`
- Storage keys: `state`, `meta`, `config`.

- [ ] **Step 1: Write the failing test**

Create `test/store.test.js`:

```js
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module .../extension/lib/store.js`

- [ ] **Step 3: Write `extension/lib/api.js`**

```js
// Chrome exposes promise-returning `chrome.*` under MV3; Firefox exposes
// promise-returning `browser.*`. Resolve once so no other module has to care.
export const api = globalThis.browser ?? globalThis.chrome;
```

- [ ] **Step 4: Write `extension/lib/store.js`**

```js
import { emptyState, merge, prune, setHidden as setHiddenIn } from './merge.js';

const STATE_KEY = 'state';
const META_KEY = 'meta';
const CONFIG_KEY = 'config';

const DEFAULT_META = { lastSyncAt: null, lastError: null };
const DEFAULT_CONFIG = { url: '', token: '' };

// Takes the storage area as an argument so tests can supply a fake one and the
// module never has to reach for a global.
export function createStore(area) {
  async function load() {
    const got = await area.get(STATE_KEY);
    return got[STATE_KEY] ?? emptyState();
  }

  async function save(state, now = Date.now()) {
    const pruned = prune(state, now);
    await area.set({ [STATE_KEY]: pruned });
    return pruned;
  }

  return {
    load,
    save,

    async setHidden(id, hidden, now = Date.now()) {
      return save(setHiddenIn(await load(), id, hidden, now), now);
    },

    async applyRemote(remote, now = Date.now()) {
      return save(merge(await load(), remote), now);
    },

    async loadMeta() {
      const got = await area.get(META_KEY);
      return { ...DEFAULT_META, ...(got[META_KEY] ?? {}) };
    },

    async saveMeta(patch) {
      const got = await area.get(META_KEY);
      const next = { ...DEFAULT_META, ...(got[META_KEY] ?? {}), ...patch };
      await area.set({ [META_KEY]: next });
      return next;
    },

    async loadConfig() {
      const got = await area.get(CONFIG_KEY);
      return { ...DEFAULT_CONFIG, ...(got[CONFIG_KEY] ?? {}) };
    },

    async saveConfig(config) {
      await area.set({ [CONFIG_KEY]: { ...DEFAULT_CONFIG, ...config } });
    },
  };
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test`
Expected: PASS, 33 tests total.

- [ ] **Step 6: Commit**

```bash
git add extension/lib/api.js extension/lib/store.js test/store.test.js
git commit -m "feat: add local store over browser storage"
```

---

## Task 5: Cloudflare Worker

**Files:**
- Create: `worker/src/handler.js`
- Create: `worker/src/index.js`
- Create: `worker/wrangler.toml`
- Create: `worker/README.md`
- Test: `test/worker.test.js`

**Interfaces:**
- Consumes: `merge`, `prune`, `emptyState`, `STATE_VERSION` (Task 2), imported across directories as `../../extension/lib/merge.js`. Wrangler bundles this at deploy time; Node resolves it directly in tests.
- Produces: `handleRequest(request: Request, env: {ORDERS: KVNamespace, AUTH_TOKEN: string}) => Promise<Response>`, and `KV_KEY = 'orders:v1'`.

- [ ] **Step 1: Write the failing test**

Create `test/worker.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, KV_KEY } from '../worker/src/handler.js';
import { STATE_VERSION } from '../extension/lib/merge.js';

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
  const kv = fakeKV({
    [KV_KEY]: JSON.stringify({ version: STATE_VERSION, orders: { x: { hidden: true, ts: 100 } } }),
  });
  const res = await handleRequest(
    req('POST', '/sync', { token: TOKEN, body: { version: STATE_VERSION, orders: { x: { hidden: false, ts: 200 } } } }),
    envWith(kv),
  );
  assert.equal((await res.json()).orders.x.hidden, false);
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module .../worker/src/handler.js`

- [ ] **Step 3: Write `worker/src/handler.js`**

```js
import { merge, prune, emptyState, STATE_VERSION } from '../../extension/lib/merge.js';

export const KV_KEY = 'orders:v1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// Compares in time independent of how far the strings agree, so response
// timing cannot be used to recover the token a character at a time.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function authorized(request, env) {
  if (!env.AUTH_TOKEN) return false;
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeEqual(token, env.AUTH_TOKEN);
}

async function readStored(env) {
  const raw = await env.ORDERS.get(KV_KEY);
  if (!raw) return emptyState();
  try {
    return JSON.parse(raw);
  } catch {
    // A corrupt value must not brick sync; start over rather than 500.
    return emptyState();
  }
}

export async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!authorized(request, env)) {
    return new Response(null, { status: 401, headers: CORS });
  }

  const { pathname } = new URL(request.url);

  if (request.method === 'GET' && pathname === '/list') {
    return json(await readStored(env));
  }

  if (request.method === 'POST' && pathname === '/sync') {
    let incoming;
    try {
      incoming = await request.json();
    } catch {
      return json({ error: 'invalid JSON' }, 400);
    }

    if (!incoming || typeof incoming !== 'object'
      || typeof incoming.orders !== 'object' || incoming.orders === null) {
      return json({ error: 'body must carry an orders object' }, 400);
    }

    if ((incoming.version ?? STATE_VERSION) > STATE_VERSION) {
      return json({ error: 'unsupported state version' }, 409);
    }

    let merged;
    try {
      merged = prune(merge(await readStored(env), incoming), Date.now());
    } catch {
      return json({ error: 'unsupported state version' }, 409);
    }

    await env.ORDERS.put(KV_KEY, JSON.stringify(merged));
    return json(merged);
  }

  return json({ error: 'not found' }, 404);
}
```

- [ ] **Step 4: Write `worker/src/index.js`**

```js
import { handleRequest } from './handler.js';

export default {
  fetch: (request, env) => handleRequest(request, env),
};
```

- [ ] **Step 5: Write `worker/wrangler.toml`**

Contains no secrets. `id` is filled in by Step 7.

```toml
name = "amazon-order-hider"
main = "src/index.js"
compatibility_date = "2026-08-13"

[[kv_namespaces]]
binding = "ORDERS"
id = "REPLACE_WITH_NAMESPACE_ID"
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `npm test`
Expected: PASS, 46 tests total.

- [ ] **Step 7: Write `worker/README.md` with the deploy runbook**

````markdown
# Sync Worker

Stores one JSON blob — the hidden-order set — in Cloudflare KV, behind a bearer
token. Free tier limits (100k KV reads/day, 1k writes/day, 100k requests/day)
are far beyond this extension's usage, and a Worker never pauses for inactivity.

## Deploy

```bash
cd worker
npx wrangler kv namespace create ORDERS      # copy the printed id into wrangler.toml
npx wrangler secret put AUTH_TOKEN           # paste a token; see below
npx wrangler deploy
```

Generate a token with:

```bash
openssl rand -base64 32
```

Keep that value. It goes into the extension's options page and nowhere else —
never into this repository.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/sync` | Send local state, receive the merged union. Writes KV. |
| `GET` | `/list` | Read stored state. Does not write. |

Both require `Authorization: Bearer <token>`. Everything else returns 401.

## Smoke test after deploying

```bash
curl -s -H "Authorization: Bearer $TOKEN" https://<your-worker>.workers.dev/list
# => {"version":1,"orders":{}}

curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"version":1,"orders":{"123-4567890-1234567":{"hidden":true,"ts":1}}}' \
  https://<your-worker>.workers.dev/sync
# => {"version":1,"orders":{"123-4567890-1234567":{"hidden":true,"ts":1}}}
```
````

- [ ] **Step 8: Commit**

```bash
git add worker test/worker.test.js
git commit -m "feat: add sync worker with server-side merge"
```

---

## Task 6: Worker HTTP client

**Files:**
- Create: `extension/lib/cloud.js`
- Test: `test/cloud.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime.
- Produces:
  - `class NotConfiguredError extends Error`
  - `class AuthError extends Error`
  - `class VersionMismatchError extends Error`
  - `class NetworkError extends Error`
  - `backoffDelay(attempt: number, opts?: {base, cap}) => number`
  - `createCloud({fetchImpl}) => { list(config), sync(config, state) }` where `config` is `{url, token}` and both methods resolve to a state object.

- [ ] **Step 1: Write the failing test**

Create `test/cloud.test.js`:

```js
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
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module .../extension/lib/cloud.js`

- [ ] **Step 3: Write the implementation**

Create `extension/lib/cloud.js`:

```js
export class NotConfiguredError extends Error {
  constructor() { super('sync is not configured'); this.name = 'NotConfiguredError'; }
}
export class AuthError extends Error {
  constructor() { super('the sync token was rejected'); this.name = 'AuthError'; }
}
export class VersionMismatchError extends Error {
  constructor() { super('the stored data uses a newer format'); this.name = 'VersionMismatchError'; }
}
export class NetworkError extends Error {
  constructor(message) { super(message); this.name = 'NetworkError'; }
}

const REQUEST_TIMEOUT_MS = 10_000;

// 2s, 4s, 8s … capped at five minutes.
export function backoffDelay(attempt, { base = 2000, cap = 300_000 } = {}) {
  return Math.min(cap, base * 2 ** attempt);
}

export function createCloud({ fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
  async function call({ url, token }, path, init = {}) {
    if (!url || !token) throw new NotConfiguredError();

    let response;
    try {
      response = await fetchImpl(`${url.replace(/\/+$/, '')}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new NetworkError(`request failed: ${cause.message}`);
    }

    if (response.status === 401) throw new AuthError();
    if (response.status === 409) throw new VersionMismatchError();
    if (!response.ok) throw new NetworkError(`server returned ${response.status}`);

    let body;
    try {
      body = await response.json();
    } catch {
      throw new NetworkError('server returned a non-JSON body');
    }

    if (!body || typeof body.orders !== 'object' || body.orders === null) {
      throw new NetworkError('server returned a body with no orders object');
    }
    return body;
  }

  return {
    list: (config) => call(config, '/list', { method: 'GET' }),
    sync: (config, state) => call(config, '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    }),
  };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm test`
Expected: PASS, 57 tests total.

- [ ] **Step 5: Commit**

```bash
git add extension/lib/cloud.js test/cloud.test.js
git commit -m "feat: add worker http client with typed errors and backoff"
```

---

## Task 7: Background sync orchestration and manifest

**Files:**
- Create: `extension/background/worker.js`
- Create: `extension/manifest.json`
- Create: `extension/content/orders.js` (placeholder, replaced in Task 8)
- Create: `extension/content/orders.css` (placeholder, filled in Task 9)

**Interfaces:**
- Consumes: `api` (Task 4), `createStore` (Task 4), `createCloud`, `backoffDelay`, error classes (Task 6).
- Produces the message protocol, which Tasks 8, 10 and 11 all speak:
  - `{ type: 'aa:setHidden', id: string, hidden: boolean }` → `{ ok: true, state }` or `{ ok: false, error: string }`
  - `{ type: 'aa:getState' }` → `{ ok: true, state, meta, configured: boolean }`
  - `{ type: 'aa:syncNow' }` → `{ ok: true, state }` or `{ ok: false, error: string }`
- Alarm name: `aa-periodic-sync`, period 30 minutes.

- [ ] **Step 1: Write `extension/background/worker.js`**

There is no unit test for this file: it is thin glue over units already tested in Tasks 2, 4 and 6, and testing it would mean mocking the whole extension runtime. Its behavior is covered by the manual checklist in Task 11.

```js
import { api } from '../lib/api.js';
import { createStore } from '../lib/store.js';
import { createCloud, backoffDelay, NotConfiguredError } from '../lib/cloud.js';

const store = createStore(api.storage.local);
const cloud = createCloud({});

const SYNC_DEBOUNCE_MS = 2000;
const ALARM_NAME = 'aa-periodic-sync';

let debounceTimer = null;
let failures = 0;
let retryTimer = null;

function describeError(error) {
  if (error instanceof NotConfiguredError) return null; // not a failure worth showing
  return `${error.name}: ${error.message}`;
}

async function pushSync() {
  clearTimeout(retryTimer);
  retryTimer = null;

  const config = await store.loadConfig();
  try {
    const local = await store.load();
    const merged = await cloud.sync(config, local);
    const state = await store.applyRemote(merged);
    failures = 0;
    await store.saveMeta({ lastSyncAt: Date.now(), lastError: null });
    return state;
  } catch (error) {
    const message = describeError(error);
    await store.saveMeta({ lastError: message });
    if (message && error.name !== 'AuthError' && error.name !== 'VersionMismatchError') {
      // Transient. Retry with backoff; a bad token or a newer schema will not
      // fix itself, so those wait for the next natural trigger instead.
      retryTimer = setTimeout(pushSync, backoffDelay(failures));
      failures += 1;
    }
    throw error;
  }
}

function scheduleSync() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { pushSync().catch(() => {}); }, SYNC_DEBOUNCE_MS);
}

async function pullSync() {
  const config = await store.loadConfig();
  try {
    const remote = await cloud.list(config);
    const state = await store.applyRemote(remote);
    await store.saveMeta({ lastSyncAt: Date.now(), lastError: null });
    return state;
  } catch (error) {
    await store.saveMeta({ lastError: describeError(error) });
    throw error;
  }
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'aa:setHidden': {
          const state = await store.setHidden(message.id, message.hidden);
          scheduleSync();
          return { ok: true, state };
        }
        case 'aa:getState': {
          const [state, meta, config] = await Promise.all([
            store.load(), store.loadMeta(), store.loadConfig(),
          ]);
          // Fire and forget: the popup renders from local state immediately.
          pullSync().catch(() => {});
          return { ok: true, state, meta, configured: Boolean(config.url && config.token) };
        }
        case 'aa:syncNow':
          return { ok: true, state: await pushSync() };
        default:
          return { ok: false, error: `unknown message: ${message?.type}` };
      }
    } catch (error) {
      return { ok: false, error: `${error.name}: ${error.message}` };
    }
  })().then(sendResponse);

  return true; // keep the channel open for the async response
});

api.alarms.create(ALARM_NAME, { periodInMinutes: 30 });
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) pushSync().catch(() => {});
});

api.runtime.onStartup.addListener(() => { pushSync().catch(() => {}); });
api.runtime.onInstalled.addListener(() => { pushSync().catch(() => {}); });
```

- [ ] **Step 2: Create the placeholder content script and stylesheet**

The manifest must reference files that exist or the extension will not load. Both are replaced in Tasks 8 and 9.

`extension/content/orders.js`:

```js
// Replaced in Task 8.
```

`extension/content/orders.css`:

```css
/* Replaced in Task 9. */
```

- [ ] **Step 3: Write `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Amazon Order Hider",
  "version": "1.0.0",
  "description": "Hide orders from your Amazon order history, with sync across your browsers.",
  "permissions": ["storage", "alarms"],
  "optional_host_permissions": ["https://*/*"],
  "background": {
    "service_worker": "background/worker.js",
    "scripts": ["background/worker.js"],
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": [
        "*://www.amazon.com/gp/your-account/order-history*",
        "*://www.amazon.com/gp/css/order-history*",
        "*://www.amazon.com/your-orders/orders*"
      ],
      "js": ["lib/rules.js", "content/orders.js"],
      "css": ["content/orders.css"],
      "run_at": "document_start",
      "all_frames": false
    }
  ],
  "action": {
    "default_popup": "popup/popup.html",
    "default_title": "Amazon Order Hider"
  },
  "options_ui": {
    "page": "options/options.html",
    "open_in_tab": true
  },
  "browser_specific_settings": {
    "gecko": {
      "id": "amazon-order-hider@nicholassmith",
      "strict_min_version": "121.0"
    }
  }
}
```

`background.service_worker` is Chrome's key and `background.scripts` is Firefox's; each browser ignores the other's with a harmless warning, which is what lets one manifest serve both.

Note the manifest references `popup/popup.html` and `options/options.html`, which do not exist until Tasks 10 and 11. The extension will not load cleanly until then — that is expected, and Step 4 only checks that the JSON is well-formed.

- [ ] **Step 4: Verify the manifest parses and the tests still pass**

Run: `node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('manifest ok')" && npm test`
Expected: `manifest ok`, then PASS, 57 tests.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json extension/background/worker.js extension/content
git commit -m "feat: add background sync orchestration and manifest"
```

---

## Task 8: Content script — hiding and buttons

**Files:**
- Modify: `extension/content/orders.js`

**Interfaces:**
- Consumes: `globalThis.AA.{CARD_SELECTOR, orderIdFromSlotId, hiddenIds, buildStyleText}` (Tasks 1, 3); the `aa:setHidden` message (Task 7).
- Produces: DOM contract used by `orders.css` in Task 9 — `#aa-hide-style`, `html.aa-reveal`, `.aa-btn`, `.aa-toggle`, `.aa-toggle-bar`, and `data-aa-decorated` on decorated cards.

- [ ] **Step 1: Confirm the card header selector against the live page**

The available markup sample covers only the card's opening `<div>`, so the element the Hide button attaches to is unverified. Open a real order history page, inspect one card, and note which of the candidates below exists. If none do, add the correct one to the front of `HEADER_CANDIDATES`. The absolute-positioning fallback keeps the button usable either way, so this step tunes placement rather than unblocking the task.

- [ ] **Step 2: Replace `extension/content/orders.js`**

```js
(function () {
  const { CARD_SELECTOR, orderIdFromSlotId, hiddenIds, buildStyleText } = globalThis.AA;

  const STYLE_ID = 'aa-hide-style';
  const DECORATED_ATTR = 'data-aa-decorated';

  // Tried in order; the first match hosts the button. Amazon's card internals
  // are not contractual, so an absolute-positioned fallback ends the list.
  const HEADER_CANDIDATES = [
    '.order-header',
    '.a-box.order-header',
    '.order-info',
    ':scope > .a-box-group > .a-box:first-child',
  ];

  let hidden = new Set();
  let revealed = false;

  function styleElement() {
    let element = document.getElementById(STYLE_ID);
    if (!element) {
      element = document.createElement('style');
      element.id = STYLE_ID;
      // documentElement exists at document_start; head may not yet.
      document.documentElement.appendChild(element);
    }
    return element;
  }

  function buttonHost(card) {
    for (const selector of HEADER_CANDIDATES) {
      const found = card.querySelector(selector);
      if (found) return { host: found, floating: false };
    }
    return { host: card, floating: true };
  }

  function decorate(card) {
    if (card.hasAttribute(DECORATED_ATTR)) return;
    const id = orderIdFromSlotId(card.getAttribute('data-csa-c-slot-id'));
    if (!id) return;

    card.setAttribute(DECORATED_ATTR, '1');

    const { host, floating } = buttonHost(card);
    if (floating) card.classList.add('aa-card-relative');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = floating ? 'aa-btn aa-btn-floating' : 'aa-btn';
    button.dataset.aaOrderId = id;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle(id, button);
    });
    host.appendChild(button);
    labelButton(button, id);
  }

  function labelButton(button, id) {
    const isHidden = hidden.has(id);
    button.textContent = isHidden ? 'Unhide' : 'Hide';
    button.title = isHidden
      ? `Unhide order ${id}`
      : `Hide order ${id} from this list`;
    button.setAttribute('aria-pressed', String(isHidden));
  }

  async function toggle(id, button) {
    const next = !hidden.has(id);
    button.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'aa:setHidden', id, hidden: next,
      });
      if (!response?.ok) throw new Error(response?.error ?? 'no response');
      // storage.onChanged drives the re-render, so nothing else to do here.
    } catch (error) {
      console.warn('[amazon-order-hider] could not update order', id, error);
    } finally {
      button.disabled = false;
    }
  }

  function toggleBar() {
    let bar = document.getElementById('aa-toggle-bar');
    if (bar) return bar;

    const anchor = document.querySelector(CARD_SELECTOR);
    if (!anchor || !anchor.parentElement) return null;

    bar = document.createElement('div');
    bar.id = 'aa-toggle-bar';
    bar.className = 'aa-toggle-bar';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'aa-toggle';
    button.addEventListener('click', () => {
      revealed = !revealed;
      document.documentElement.classList.toggle('aa-reveal', revealed);
      render();
    });

    bar.appendChild(button);
    anchor.parentElement.insertBefore(bar, anchor);
    return bar;
  }

  function renderToggle() {
    const bar = toggleBar();
    if (!bar) return;
    const button = bar.querySelector('.aa-toggle');
    bar.hidden = hidden.size === 0;
    if (hidden.size === 0 && revealed) {
      revealed = false;
      document.documentElement.classList.remove('aa-reveal');
    }
    button.textContent = revealed
      ? `Hide hidden orders (${hidden.size})`
      : `Show hidden orders (${hidden.size})`;
    button.setAttribute('aria-expanded', String(revealed));
  }

  function render() {
    styleElement().textContent = buildStyleText([...hidden]);
    for (const card of document.querySelectorAll(CARD_SELECTOR)) decorate(card);
    for (const button of document.querySelectorAll('.aa-btn')) {
      labelButton(button, button.dataset.aaOrderId);
    }
    renderToggle();
  }

  function observe() {
    let pending = false;
    const observer = new MutationObserver(() => {
      // Hiding is already handled by the stylesheet, so this only needs to
      // catch up on button injection — a frame of latency is harmless.
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; render(); });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function init() {
    try {
      const got = await chrome.storage.local.get('state');
      hidden = new Set(hiddenIds(got.state));
    } catch (error) {
      console.warn('[amazon-order-hider] could not read hidden orders', error);
    }
    render();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.state) return;
      hidden = new Set(hiddenIds(changes.state.newValue));
      render();
    });

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', render, { once: true });
    }
    observe();
  }

  init();
})();
```

- [ ] **Step 3: Verify the tests still pass**

Run: `npm test`
Expected: PASS, 57 tests. This task changes no tested module; the check guards against an accidental edit to `lib/rules.js`.

- [ ] **Step 4: Commit**

```bash
git add extension/content/orders.js
git commit -m "feat: hide order cards and inject hide buttons"
```

---

## Task 9: Content script styling

**Files:**
- Modify: `extension/content/orders.css`

**Interfaces:**
- Consumes: the DOM contract from Task 8.
- Produces: no JavaScript interface.

- [ ] **Step 1: Replace `extension/content/orders.css`**

```css
/* All injected UI is prefixed aa- to avoid colliding with Amazon's styles. */

.aa-card-relative {
  position: relative;
}

.aa-btn {
  margin-left: 12px;
  padding: 2px 10px;
  border: 1px solid #d5d9d9;
  border-radius: 8px;
  background: #fff;
  color: #0f1111;
  font-size: 12px;
  line-height: 20px;
  cursor: pointer;
}

.aa-btn:hover {
  background: #f7fafa;
  border-color: #a6a6a6;
}

.aa-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.aa-btn-floating {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
}

.aa-toggle-bar {
  display: flex;
  justify-content: flex-end;
  margin: 8px 0;
}

.aa-toggle-bar[hidden] {
  display: none;
}

.aa-toggle {
  padding: 4px 12px;
  border: 1px solid #d5d9d9;
  border-radius: 8px;
  background: #f0f2f2;
  color: #0f1111;
  font-size: 13px;
  cursor: pointer;
}

.aa-toggle:hover {
  background: #e3e6e6;
}
```

The `display: none` and reveal rules are not here — they are generated per hidden ID by `buildStyleText` and injected into `#aa-hide-style` at `document_start`.

- [ ] **Step 2: Commit**

```bash
git add extension/content/orders.css
git commit -m "style: add styling for injected hide controls"
```

---

## Task 10: Options page

**Files:**
- Create: `extension/options/options.html`
- Create: `extension/options/options.js`

**Interfaces:**
- Consumes: `api` (Task 4), `createStore` (Task 4), `createCloud` (Task 6).
- Produces: populated `config` storage key, consumed by the background script.

- [ ] **Step 1: Write `extension/options/options.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Amazon Order Hider — Settings</title>
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 1rem; color: #0f1111; }
    h1 { font-size: 1.25rem; }
    label { display: block; margin-top: 1rem; font-weight: 600; }
    input { width: 100%; padding: 0.5rem; margin-top: 0.25rem; border: 1px solid #888; border-radius: 6px; box-sizing: border-box; font: inherit; }
    button { margin-top: 1.25rem; padding: 0.5rem 1rem; border: 1px solid #888; border-radius: 6px; background: #f0f2f2; font: inherit; cursor: pointer; }
    .hint { color: #565959; font-size: 0.85rem; margin-top: 0.25rem; }
    .status { margin-top: 1rem; padding: 0.5rem 0.75rem; border-radius: 6px; }
    .status.ok { background: #e7f6e7; }
    .status.err { background: #fbeaea; }
    .status:empty { display: none; }
  </style>
</head>
<body>
  <h1>Amazon Order Hider</h1>
  <p>Hiding works without any of this. These settings only add sync between your browsers.</p>

  <label for="url">Worker URL</label>
  <input id="url" type="url" placeholder="https://amazon-order-hider.you.workers.dev" autocomplete="off">
  <div class="hint">The URL printed by <code>npx wrangler deploy</code>.</div>

  <label for="token">Bearer token</label>
  <input id="token" type="password" autocomplete="off">
  <div class="hint">The value you set with <code>npx wrangler secret put AUTH_TOKEN</code>.</div>

  <button id="save" type="button">Save and test connection</button>
  <div id="status" class="status" role="status"></div>

  <script type="module" src="options.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `extension/options/options.js`**

```js
import { api } from '../lib/api.js';
import { createStore } from '../lib/store.js';
import { createCloud } from '../lib/cloud.js';

const store = createStore(api.storage.local);
const cloud = createCloud({});

const urlInput = document.getElementById('url');
const tokenInput = document.getElementById('token');
const statusBox = document.getElementById('status');

function show(message, ok) {
  statusBox.textContent = message;
  statusBox.className = `status ${ok ? 'ok' : 'err'}`;
}

const existing = await store.loadConfig();
urlInput.value = existing.url;
tokenInput.value = existing.token;

document.getElementById('save').addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const token = tokenInput.value.trim();

  if (!url || !token) {
    show('Enter both a Worker URL and a token.', false);
    return;
  }

  let origin;
  try {
    origin = `${new URL(url).origin}/*`;
  } catch {
    show('That does not look like a valid URL.', false);
    return;
  }

  // The Worker URL is user-supplied, so it cannot be a static host permission.
  // Request it now, which costs one prompt at setup and no standing access.
  const granted = await api.permissions.request({ origins: [origin] });
  if (!granted) {
    show('Permission for that host was declined, so sync cannot run.', false);
    return;
  }

  await store.saveConfig({ url, token });

  try {
    const remote = await cloud.list({ url, token });
    await store.applyRemote(remote);
    await store.saveMeta({ lastSyncAt: Date.now(), lastError: null });
    const count = Object.values(remote.orders).filter((entry) => entry.hidden).length;
    show(`Connected. ${count} hidden order${count === 1 ? '' : 's'} on the server.`, true);
  } catch (error) {
    await store.saveMeta({ lastError: `${error.name}: ${error.message}` });
    show(`Saved, but the connection test failed — ${error.message}`, false);
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add extension/options
git commit -m "feat: add options page for worker url and token"
```

---

## Task 11: Popup, verification checklist, and README

**Files:**
- Create: `extension/popup/popup.html`
- Create: `extension/popup/popup.js`
- Create: `extension/popup/popup.css`
- Create: `docs/manual-verification.md`
- Create: `README.md`

**Interfaces:**
- Consumes: `aa:getState` and `aa:setHidden` (Task 7); `globalThis.AA.hiddenIds` via side-effect import of `lib/rules.js` (Task 3).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write `extension/popup/popup.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Hidden orders</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <header>
    <h1>Hidden orders</h1>
    <span id="count" class="count"></span>
  </header>
  <ul id="list" class="list"></ul>
  <p id="empty" class="empty" hidden>No hidden orders yet. Use the Hide button on any order card.</p>
  <footer>
    <span id="sync" class="sync"></span>
    <button id="settings" type="button">Settings</button>
  </footer>
  <script type="module" src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `extension/popup/popup.css`**

```css
body {
  width: 22rem;
  margin: 0;
  padding: 0.75rem;
  font: 13px/1.5 system-ui, sans-serif;
  color: #0f1111;
}

header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

h1 { font-size: 1rem; margin: 0; }
.count { color: #565959; }

.list { list-style: none; margin: 0; padding: 0; max-height: 22rem; overflow-y: auto; }

.list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.4rem 0;
  border-bottom: 1px solid #eee;
}

.list a { font-family: ui-monospace, monospace; color: #007185; text-decoration: none; }
.list a:hover { text-decoration: underline; }

button {
  padding: 0.2rem 0.6rem;
  border: 1px solid #d5d9d9;
  border-radius: 6px;
  background: #f0f2f2;
  font: inherit;
  cursor: pointer;
}

button:hover { background: #e3e6e6; }
button:disabled { opacity: 0.5; cursor: default; }

.empty { color: #565959; }

footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-top: 0.75rem;
  padding-top: 0.5rem;
  border-top: 1px solid #eee;
}

.sync { color: #565959; font-size: 0.85em; }
.sync.err { color: #b12704; }
```

- [ ] **Step 3: Write `extension/popup/popup.js`**

```js
import { api } from '../lib/api.js';
import '../lib/rules.js'; // side-effect import: populates globalThis.AA

const { hiddenIds } = globalThis.AA;

const listElement = document.getElementById('list');
const emptyElement = document.getElementById('empty');
const countElement = document.getElementById('count');
const syncElement = document.getElementById('sync');

const ORDER_URL = 'https://www.amazon.com/gp/your-account/order-details?orderID=';

function relativeTime(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function renderSyncStatus(meta, configured) {
  if (!configured) {
    syncElement.textContent = 'Sync not set up';
    syncElement.className = 'sync';
    return;
  }
  if (meta.lastError) {
    syncElement.textContent = `Sync failed — ${meta.lastError}`;
    syncElement.className = 'sync err';
    return;
  }
  syncElement.textContent = meta.lastSyncAt
    ? `Synced ${relativeTime(meta.lastSyncAt)}`
    : 'Not synced yet';
  syncElement.className = 'sync';
}

function renderList(state) {
  // Most recently hidden first.
  const ids = hiddenIds(state).sort((a, b) => state.orders[b].ts - state.orders[a].ts);

  countElement.textContent = ids.length ? String(ids.length) : '';
  emptyElement.hidden = ids.length > 0;
  listElement.replaceChildren();

  for (const id of ids) {
    const item = document.createElement('li');

    const link = document.createElement('a');
    link.href = ORDER_URL + encodeURIComponent(id);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = id;

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Unhide';
    button.addEventListener('click', async () => {
      button.disabled = true;
      const response = await api.runtime.sendMessage({
        type: 'aa:setHidden', id, hidden: false,
      });
      if (response?.ok) {
        renderList(response.state);
      } else {
        button.disabled = false;
        syncElement.textContent = response?.error ?? 'Could not unhide';
        syncElement.className = 'sync err';
      }
    });

    item.append(link, button);
    listElement.appendChild(item);
  }
}

const response = await api.runtime.sendMessage({ type: 'aa:getState' });
if (response?.ok) {
  renderList(response.state);
  renderSyncStatus(response.meta, response.configured);
} else {
  syncElement.textContent = 'Could not read hidden orders';
  syncElement.className = 'sync err';
}

// The background pulls in the background when the popup opens; reflect the
// result if it lands while the popup is still on screen.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state) renderList(changes.state.newValue);
});

document.getElementById('settings').addEventListener('click', () => {
  api.runtime.openOptionsPage();
});
```

- [ ] **Step 4: Write `docs/manual-verification.md`**

```markdown
# Manual verification

Automated tests cover the pure logic. This checklist covers what only a real
order history page can exercise. Run it after any change to the content script,
the manifest, or the popup.

## Load the extension

- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → pick `extension/`.
- **Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `extension/manifest.json`.

## Checklist

- [ ] Open `https://www.amazon.com/gp/your-account/order-history`. Every order card shows a **Hide** button.
- [ ] Click Hide on one card. The card disappears immediately and a **Show hidden orders (1)** control appears above the list.
- [ ] Reload the page. The card is still hidden, and it never flashes visible during load. Watch closely — a flash means the `document_start` fast path regressed.
- [ ] Click **Show hidden orders (1)**. The card reappears dimmed with a dashed outline, and its button now reads **Unhide**.
- [ ] Click **Unhide** on the revealed card. It returns to normal and the toggle disappears.
- [ ] Hide three orders, then open the popup. All three IDs are listed, most recent first.
- [ ] Click an ID in the popup. It opens that order's detail page in a new tab.
- [ ] Click **Unhide** in the popup with the orders page open behind it. The card reappears on the page without a reload.
- [ ] Hide an order, then use Amazon's own pagination to go to page 2 and back. The order is still hidden and buttons are present on the new page's cards.
- [ ] Change the year filter. Hiding still applies and buttons appear on the re-rendered cards.

## With sync configured

- [ ] Open Settings, enter the Worker URL and token, click Save. It reports how many hidden orders are on the server.
- [ ] Hide an order in Chrome, wait ~5 seconds, then open the orders page in Firefox. The same order is hidden there.
- [ ] Unhide it in Firefox, reload in Chrome. It is visible again — the tombstone propagated rather than the older hide winning.

## With sync broken

- [ ] Enter a wrong token in Settings. The page reports the failure.
- [ ] Reload the orders page. Hiding still works normally and the page shows no error or delay.
- [ ] The popup footer reads `Sync failed — AuthError: …`.
- [ ] Clear the Worker URL. The popup footer reads `Sync not set up` and hiding still works.
```

- [ ] **Step 5: Write `README.md`**

````markdown
# Amazon Order Hider

Amazon removed the ability to archive or hide orders. This restores it: a Hide
button on every order card, a toggle to reveal what you have hidden, and a popup
to unhide. Hidden orders are tracked by the ID in each card's
`data-csa-c-slot-id` attribute.

Personal-use extension for Firefox and Chrome. Not published to either store.

## Install

Load `extension/` unpacked — see [docs/manual-verification.md](docs/manual-verification.md).

## Sync (optional)

Hiding works entirely offline. To share the hidden list between browsers and
machines, deploy the Worker in [`worker/`](worker/README.md) and enter its URL
and token in the extension's Settings page.

## Develop

```bash
npm test          # node --test, no dependencies, no build step
```

Two module conventions live side by side:

- `extension/lib/*.js` (except `rules.js`), `background/`, `popup/`, `options/`,
  and `worker/src/` are ES modules with named exports.
- `extension/lib/rules.js` uses namespace assignment so it is valid **both** as a
  classic content script and as a side-effect ESM import. It must contain no
  `import`/`export` statements.

## Design

- [Design spec](docs/superpowers/specs/2026-08-13-amazon-order-hider-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-13-amazon-order-hider.md)
````

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 57 tests.

- [ ] **Step 7: Commit**

```bash
git add extension/popup docs/manual-verification.md README.md
git commit -m "feat: add popup listing hidden orders"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Order ID extraction, content-id negative case | 1 |
| LWW set, tombstones, 90-day prune, version refusal | 2 |
| CSS hiding, reveal rule, no-flash `document_start` | 3, 8 |
| `browser`/`chrome` shim | 4 |
| `storage.local` as read path, single writer | 4, 7 |
| Worker, `POST /sync`, `GET /list`, timing-safe auth, CORS, 409 | 5 |
| Typed errors, backoff 2s→5min, 10s timeout | 6 |
| Sync triggers: page load, hide/unhide debounce, popup open, 30-min alarm | 7 |
| Manifest, both browsers, gecko id, match patterns | 7 |
| Hide button, reveal toggle, MutationObserver for buttons only | 8, 9 |
| Optional host permission requested at setup | 10 |
| Popup: ID-only rows linking to order details, sync status | 11 |
| Failure matrix: unconfigured, unreachable, 401, version | 7, 10, 11 |
| Manual checklist | 11 |
| Secrets never committed | Global Constraints, 5, 10 |

**Placeholder scan:** No TBDs. Task 8 Step 1 is a live-page confirmation with a
working fallback, not deferred work. Task 7's placeholder content script is
explicitly replaced in Tasks 8 and 9.

**Type consistency:** `setHidden` names the same parameters in `merge.js`,
`store.js`, and the `aa:setHidden` message. `hiddenIds` and `buildStyleText` are
defined in Task 3 and consumed in Tasks 8 and 11 with matching signatures.
`createStore(area)` and `createCloud({fetchImpl})` match every call site.
`KV_KEY` is exported by the handler and imported by its test.
The `{ ok, state, meta, configured, error }` response shape is consistent across
Tasks 7, 8, 10, and 11.

**Deliberate omission:** The spec's file structure listed `worker/src/merge.js` as
a copy of the extension's merge module. The plan imports
`../../extension/lib/merge.js` directly instead — Wrangler bundles it at deploy
time — because two copies of a merge function that must agree byte for byte
between client and server is a defect waiting to happen.
