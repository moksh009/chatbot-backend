'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CART_RECOVERY_BODY_SLOT_PRESETS,
  FRONTEND_MIRROR,
  cartRecoveryVariableMappings,
  planCartRuleActivation,
} = require('../../constants/cartRecoverySlotPresets');
const { cartRecoveryVariableMappings: presetFromAutomation } = require('../../utils/commerce/commerceAutomationPresets');
const { buildCartRecoveryComponents } = require('../../utils/commerce/buildCartRecoveryComponents');

test('FRONTEND_MIRROR matches body slot presets (AutomationVariableMapper sync)', () => {
  assert.deepEqual(FRONTEND_MIRROR, CART_RECOVERY_BODY_SLOT_PRESETS);
  assert.deepEqual(FRONTEND_MIRROR[1], ['first_name', 'product_name', 'cart_total']);
  assert.deepEqual(FRONTEND_MIRROR[3], ['first_name', 'product_name', 'cart_total', 'discount_code']);
});

test('cartRecoveryVariableMappings align with frontend slot presets', () => {
  assert.deepEqual(cartRecoveryVariableMappings(1), presetFromAutomation(1));
  assert.deepEqual(cartRecoveryVariableMappings(2), presetFromAutomation(2));
  assert.deepEqual(cartRecoveryVariableMappings(3), presetFromAutomation(3));

  assert.deepEqual(cartRecoveryVariableMappings(1).body, {
    1: 'first_name',
    2: 'product_name',
    3: 'cart_total',
  });
  /** WS-1 fix: discount_code is now index 4 (consecutive) — Meta rejects
   *  body templates with variable gaps. */
  assert.equal(cartRecoveryVariableMappings(3).body[4], 'discount_code');
  assert.equal(cartRecoveryVariableMappings(3).body[5], undefined);
});

test('buildCartRecoveryComponents body params follow slot preset order', () => {
  const lead = {
    firstName: 'Rahul',
    cartSnapshot: {
      items: [{ title: 'Doorbell', image: 'https://cdn.shopify.com/img.jpg', price: 1499 }],
      total_price: 1499,
    },
    checkoutUrl: 'https://store.com/checkout/abc',
    discountCode: 'SAVE15',
  };
  const client = { shopDomain: 'demo.myshopify.com' };

  const step1 = buildCartRecoveryComponents(lead, client, 1);
  const body1 = step1.components.find((c) => c.type === 'body');
  assert.deepEqual(
    body1.parameters.map((p) => p.text),
    ['Rahul', 'Doorbell', '1499']
  );

  const step3 = buildCartRecoveryComponents(lead, client, 3);
  const body3 = step3.components.find((c) => c.type === 'body');
  assert.deepEqual(
    body3.parameters.map((p) => p.text),
    ['Rahul', 'Doorbell', '1499', 'SAVE15']
  );
});

test('planCartRuleActivation only activates rules when all templates approved', () => {
  assert.deepEqual(planCartRuleActivation({ allTemplatesApproved: false }), {
    count: 0,
    templateNames: [],
  });
  assert.deepEqual(planCartRuleActivation({ allTemplatesApproved: true }), {
    count: 3,
    templateNames: ['cart_recovery_1', 'cart_recovery_2', 'cart_recovery_3'],
  });
});
