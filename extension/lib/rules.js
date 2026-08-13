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
