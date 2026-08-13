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
