'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { VARIABLE_REGISTRY } = require('../../utils/core/variableRegistry');
const { REMOVED_LEGACY_GLOBAL_VARIABLES } = require('../../constants/shopifyActionVariables');
const { injectShopifyActionMessage } = require('../../utils/core/variableInjector');

test('VARIABLE_REGISTRY excludes removed legacy global names from insertable catalog', () => {
  const globalNames = new Set(
    VARIABLE_REGISTRY.filter((v) => !v.shopifyActionOnly).map((v) => v.name)
  );
  for (const removed of REMOVED_LEGACY_GLOBAL_VARIABLES) {
    assert.equal(globalNames.has(removed), false, `expected removed from global: ${removed}`);
  }
});

test('VARIABLE_REGISTRY includes Shopify Action discovery entries', () => {
  const shopify = VARIABLE_REGISTRY.filter((v) => v.category === 'Shopify Action');
  assert.equal(shopify.length, 9);
  assert.equal(shopify.some((v) => v.name === 'tracking_link'), true);
  assert.equal(shopify.every((v) => v.locked && v.shopifyActionOnly), true);
});

test('injectShopifyActionMessage uses NA for missing Shopify Action vars', () => {
  const out = injectShopifyActionMessage(
    'Hi {{first_name}}, order {{order_id}} track {{tracking_link}}',
    { order_id: '#1042' },
    { first_name: 'Priya' }
  );
  assert.match(out, /Priya/);
  assert.match(out, /#1042/);
  assert.match(out, /NA/);
});
