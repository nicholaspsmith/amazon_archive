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
