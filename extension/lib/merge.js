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
