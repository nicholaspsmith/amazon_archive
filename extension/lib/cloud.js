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
