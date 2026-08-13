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
