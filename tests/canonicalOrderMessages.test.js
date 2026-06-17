'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystemAutomations } = require('../utils/commerce/commerceAutomationPresets');
const {
  isCodShopifyOrder,
  isCommerceCanonicalOnlyEnabled,
  shouldSkipLegacyOrderDispatch,
  usesCanonicalOrderMessages,
} = require('../utils/commerce/canonicalOrderMessages');
const { dispatchOrderStatusAutomation } = require('../utils/commerce/orderEventDispatcher');

test('buildSystemAutomations includes COD confirmation rule', () => {
  const rules = buildSystemAutomations();
  const cod = rules.find((r) => r.id === 'sys_commerce_cod_confirm');
  assert.ok(cod);
  assert.equal(cod.triggerStatusType, 'payment');
  assert.equal(cod.templateName, 'cod_confirmation_v1');
});

test('isCodShopifyOrder detects COD gateways', () => {
  assert.equal(
    isCodShopifyOrder({ payment_gateway_names: ['Cash on Delivery (COD)'] }),
    true
  );
  assert.equal(isCodShopifyOrder({ payment_gateway_names: ['razorpay'] }), false);
});

test('shouldSkipLegacyOrderDispatch when tenant has active sys_ rules', () => {
  const client = {
    commerceAutomations: [
      {
        id: 'sys_fulfillment_unfulfilled',
        isActive: true,
        meta: { category: 'order_notification' },
        templateName: 'eco_order_confirmed',
      },
    ],
  };
  assert.equal(usesCanonicalOrderMessages(client), true);
  assert.equal(shouldSkipLegacyOrderDispatch(client), true);
});

test('dispatchOrderStatusAutomation skips when COMMERCE_CANONICAL_ONLY=true', async () => {
  const prev = process.env.COMMERCE_CANONICAL_ONLY;
  process.env.COMMERCE_CANONICAL_ONLY = 'true';
  try {
    const out = await dispatchOrderStatusAutomation({
      clientConfig: { clientId: 'test_tenant' },
      order: { _id: '1', orderId: '1001', status: 'paid' },
      previousStatus: 'pending',
      newStatus: 'paid',
      source: 'test',
    });
    assert.equal(out.skipped, true);
    assert.equal(out.reason, 'commerce_canonical_only');
  } finally {
    if (prev === undefined) delete process.env.COMMERCE_CANONICAL_ONLY;
    else process.env.COMMERCE_CANONICAL_ONLY = prev;
  }
});
