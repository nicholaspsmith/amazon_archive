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
