import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/lib/rules.js';

const { orderIdFromSlotId } = globalThis.AA;

test('extracts the order id from a well-formed slot id', () => {
  assert.equal(
    orderIdFromSlotId('amzn1.yourorders.order-card.123-4567890-1234567'),
    '123-4567890-1234567',
  );
});

test('extracts digital order ids that carry a letter prefix', () => {
  assert.equal(
    orderIdFromSlotId('amzn1.yourorders.order-card.D01-2345678-1234567'),
    'D01-2345678-1234567',
  );
});

test('rejects the content-id value, which shares the prefix but carries no id', () => {
  // data-csa-c-content-id sits on the same element as data-csa-c-slot-id.
  // Matching it would produce a selector that hides every order card.
  assert.equal(orderIdFromSlotId('amzn1.yourorders.order-card'), null);
});

test('rejects a trailing dot with no id after it', () => {
  assert.equal(orderIdFromSlotId('amzn1.yourorders.order-card.'), null);
});

test('rejects ids containing characters that could break out of a CSS selector', () => {
  for (const evil of [
    'amzn1.yourorders.order-card.111"] , * {display:block} [x="',
    'amzn1.yourorders.order-card.111]',
    'amzn1.yourorders.order-card.a b',
    'amzn1.yourorders.order-card.111.222',
  ]) {
    assert.equal(orderIdFromSlotId(evil), null, `should reject: ${evil}`);
  }
});

test('rejects unrelated and non-string input', () => {
  for (const bad of ['', 'amzn1.something.else.123', null, undefined, 42, {}]) {
    assert.equal(orderIdFromSlotId(bad), null);
  }
});

const { hiddenIds, buildStyleText, CARD_SELECTOR } = globalThis.AA;

test('hiddenIds returns only entries flagged hidden', () => {
  const state = {
    version: 1,
    orders: {
      'a-1': { hidden: true, ts: 3 },
      'b-2': { hidden: false, ts: 4 },
      'c-3': { hidden: true, ts: 5 },
    },
  };
  assert.deepEqual(hiddenIds(state).sort(), ['a-1', 'c-3']);
});

test('hiddenIds tolerates missing and empty state', () => {
  assert.deepEqual(hiddenIds(undefined), []);
  assert.deepEqual(hiddenIds({}), []);
  assert.deepEqual(hiddenIds({ orders: {} }), []);
});

test('buildStyleText returns nothing when there is nothing to hide', () => {
  assert.equal(buildStyleText([]), '');
});

test('buildStyleText emits a suffix selector per id', () => {
  const css = buildStyleText(['123-4567890-1234567']);
  assert.match(css, /\[data-csa-c-slot-id\$="\.123-4567890-1234567"\]/);
  assert.match(css, /display:\s*none/);
});

test('buildStyleText emits a reveal rule gated on the aa-reveal class', () => {
  const css = buildStyleText(['123-4567890-1234567']);
  assert.match(css, /html\.aa-reveal/);
  assert.match(css, /opacity/);
});

test('buildStyleText skips ids that fail validation', () => {
  // Defence in depth: even if a bad id reaches storage, it must not reach CSS.
  const css = buildStyleText(['good-1', 'bad"] * {display:block} [x="']);
  assert.match(css, /good-1/);
  assert.ok(!css.includes('bad'), 'the rejected id must not reach the stylesheet');
  // One surviving id means one selector in the hide rule and one in the reveal
  // rule. A leaked payload would push this count higher.
  assert.equal(css.match(/data-csa-c-slot-id\$=/g).length, 2);
});

test('CARD_SELECTOR matches the slot-id prefix', () => {
  assert.equal(CARD_SELECTOR, '[data-csa-c-slot-id^="amzn1.yourorders.order-card."]');
});
