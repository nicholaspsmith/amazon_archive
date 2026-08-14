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
