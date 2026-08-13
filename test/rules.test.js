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
