'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateSyncRule,
  evaluateTriggerRules,
} = require('../../services/journeyBuilder/journeyTriggerEvaluator');
const { serializeTriggerRules, normalizeTriggerRules } = require('../../services/journeyBuilder/triggerFilterCatalog');

const COD_ORDER = {
  name: '#1001',
  total_price: '1200.00',
  payment_gateway_names: ['Cash on Delivery (COD)'],
  line_items: [{ product_id: '111' }],
  customer: { id: 'cust_1' },
  tags: 'wholesale, vip',
  shipping_address: { province: 'Maharashtra', city: 'Mumbai' },
};

const PREPAID_ORDER = {
  name: '#1002',
  total_price: '999.00',
  payment_gateway_names: ['razorpay'],
  gateway: 'razorpay',
  line_items: [{ product_id: '222' }],
  customer: { id: 'cust_2' },
  tags: 'retail',
  shipping_address: { province: 'Gujarat', city: 'Ahmedabad' },
};

test('payment_method cod matches COD Shopify order', () => {
  assert.equal(
    evaluateSyncRule({ attribute: 'payment_method', operator: 'is', value: 'cod' }, 'order_placed', COD_ORDER),
    true
  );
  assert.equal(
    evaluateSyncRule({ attribute: 'payment_method', operator: 'is', value: 'cod' }, 'order_placed', PREPAID_ORDER),
    false
  );
});

test('payment_method prepaid matches non-COD order', () => {
  assert.equal(
    evaluateSyncRule({ attribute: 'payment_method', operator: 'is', value: 'prepaid' }, 'order_shipped', PREPAID_ORDER),
    true
  );
  assert.equal(
    evaluateSyncRule({ attribute: 'payment_method', operator: 'is', value: 'prepaid' }, 'order_shipped', COD_ORDER),
    false
  );
});

test('order_total_min and max', () => {
  assert.equal(
    evaluateSyncRule({ attribute: 'order_total_min', operator: 'gte', value: 1000 }, 'order_placed', COD_ORDER),
    true
  );
  assert.equal(
    evaluateSyncRule({ attribute: 'order_total_max', operator: 'lte', value: 1000 }, 'order_placed', PREPAID_ORDER),
    true
  );
});

test('products includes_any', () => {
  assert.equal(
    evaluateSyncRule({ attribute: 'products', operator: 'includes_any', value: ['111'] }, 'order_placed', COD_ORDER),
    true
  );
  assert.equal(
    evaluateSyncRule({ attribute: 'products', operator: 'includes_any', value: ['999'] }, 'order_placed', COD_ORDER),
    false
  );
});

test('order_tags and shipping_state', () => {
  assert.equal(
    evaluateSyncRule({ attribute: 'order_tags', operator: 'includes_any', value: ['wholesale'] }, 'order_placed', COD_ORDER),
    true
  );
  assert.equal(
    evaluateSyncRule({ attribute: 'shipping_state', operator: 'is', value: 'Maharashtra' }, 'order_placed', COD_ORDER),
    true
  );
});

test('legacy codOnly migrates and evaluates', async () => {
  const filters = serializeTriggerRules(normalizeTriggerRules({ codOnly: true }));
  const { match } = await evaluateTriggerRules({
    clientId: 'client_test',
    triggerType: 'order_placed',
    payload: COD_ORDER,
    filters,
  });
  assert.equal(match, true);

  const prepaid = await evaluateTriggerRules({
    clientId: 'client_test',
    triggerType: 'order_placed',
    payload: PREPAID_ORDER,
    filters,
  });
  assert.equal(prepaid.match, false);
});

test('empty rules match all', async () => {
  const { match } = await evaluateTriggerRules({
    clientId: 'client_test',
    triggerType: 'order_placed',
    payload: PREPAID_ORDER,
    filters: {},
  });
  assert.equal(match, true);
});
