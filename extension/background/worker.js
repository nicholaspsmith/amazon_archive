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
