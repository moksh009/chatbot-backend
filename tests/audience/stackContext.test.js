'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { visibleSourceIds } = require('../../utils/audience/sourceVisibility');

test('hides shopify checkout when Gokwik declared', () => {
  const ids = visibleSourceIds({
    storePlatform: 'shopify',
    thirdPartyCheckout: { detected: 'gokwik' },
    shopifyDetails: { connected: true },
  });
  assert.ok(!ids.includes('shopify_checkout'));
  assert.ok(ids.includes('third_party_checkout'));
});

test('shows shopify checkout for native checkout', () => {
  const ids = visibleSourceIds({
    storePlatform: 'shopify',
    thirdPartyCheckout: { detected: 'shopify_native' },
    shopifyDetails: { connected: true },
  });
  assert.ok(ids.includes('shopify_checkout'));
  assert.ok(!ids.includes('third_party_checkout') || ids.includes('third_party_checkout'));
});

test('always includes keyword and csv', () => {
  const ids = visibleSourceIds({
    storePlatform: 'shopify',
    thirdPartyCheckout: { detected: 'gokwik' },
    shopifyDetails: { connected: true },
  });
  assert.ok(ids.includes('whatsapp_keyword'));
  assert.ok(ids.includes('manual_import'));
});
