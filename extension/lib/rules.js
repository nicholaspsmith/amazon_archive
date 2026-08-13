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

  root.AA = Object.assign(root.AA || {}, {
    SLOT_PREFIX, CARD_SELECTOR, orderIdFromSlotId, hiddenIds, buildStyleText,
  });
})(globalThis);
