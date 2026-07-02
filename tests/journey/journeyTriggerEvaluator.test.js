'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateSyncRule,
  evaluateTriggerRules,
  cartProductIdsFromPayload,
} = require('../../services/journeyBuilder/journeyTriggerEvaluator');
const { serializeTriggerRules, normalizeTriggerRules } = require('../../services/journeyBuilder/triggerFilterCatalog');

const COD_ORDER = {
  name: '#1001',
  total_price: '1200.00',
  payment_gateway_names: ['Cash on Delivery (COD)'],
  line_items: [{ product_id: '111' }],
  customer: { id: 'cust_1' },
};

const PREPAID_ORDER = {
  name: '#1002',
  total_price: '999.00',
  payment_gateway_names: ['razorpay'],
  gateway: 'razorpay',
  line_items: [{ product_id: '222' }],
  customer: { id: 'cust_2' },
};

const CART_LEAD = {
  phoneNumber: '919876543210',
  cartValue: 1500,
  cartItems: [{ product_id: '555' }, { product_id: '666' }],
  cartAbandonedAt: new Date(Date.now() - 30 * 60 * 1000),
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

test('cart_products reads AdLead cartItems', () => {
  const ids = cartProductIdsFromPayload(CART_LEAD);
  assert.deepEqual(ids, ['555', '666']);
  assert.equal(
    evaluateSyncRule({ attribute: 'cart_products', operator: 'includes_any', value: ['555'] }, 'cart_abandoned', CART_LEAD),
    true
  );
});

test('cart_delay enforces wait minutes', () => {
  const recentLead = { ...CART_LEAD, cartAbandonedAt: new Date(Date.now() - 5 * 60 * 1000) };
  assert.equal(
    evaluateSyncRule({ attribute: 'cart_delay', operator: 'is', value: 25 }, 'cart_abandoned', recentLead),
    false
  );
  assert.equal(
    evaluateSyncRule({ attribute: 'cart_delay', operator: 'is', value: 25 }, 'cart_abandoned', CART_LEAD),
    true
  );
});

test('order_tags includes_any matches tagged order', () => {
  const taggedOrder = { ...COD_ORDER, tags: 'vip, wholesale' };
  assert.equal(
    evaluateSyncRule({ attribute: 'order_tags', operator: 'includes_any', value: ['vip'] }, 'order_placed', taggedOrder),
    true
  );
  assert.equal(
    evaluateSyncRule({ attribute: 'order_tags', operator: 'includes_any', value: ['wholesale'] }, 'order_placed', COD_ORDER),
    false
  );
});

test('discount_code includes_any', () => {
  const withCode = {
    ...PREPAID_ORDER,
    discount_codes: [{ code: 'SAVE10' }],
  };
  assert.equal(
    evaluateSyncRule({ attribute: 'discount_code', operator: 'includes_any', value: ['SAVE10'] }, 'order_placed', withCode),
    true
  );
});

test('line_item_count_min', () => {
  const multiItem = {
    ...COD_ORDER,
    line_items: [{ product_id: '1' }, { product_id: '2' }],
  };
  assert.equal(
    evaluateSyncRule({ attribute: 'line_item_count_min', operator: 'gte', value: 2 }, 'order_placed', multiItem),
    true
  );
  assert.equal(
    evaluateSyncRule({ attribute: 'line_item_count_min', operator: 'gte', value: 3 }, 'order_placed', multiItem),
    false
  );
});

test('unknown attribute fails closed', () => {
  assert.equal(
    evaluateSyncRule({ attribute: 'shipping_city', operator: 'is', value: 'Mumbai' }, 'order_placed', COD_ORDER),
    false
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

test('removed attributes stripped on normalize', () => {
  const rules = normalizeTriggerRules({
    rules: [
      { attribute: 'shipping_city', operator: 'is', value: 'Mumbai' },
      { attribute: 'order_tags', operator: 'includes_any', value: ['vip'] },
      { attribute: 'payment_method', operator: 'is', value: 'cod' },
    ],
  });
  assert.equal(rules.length, 2);
  assert.ok(rules.some((r) => r.attribute === 'order_tags'));
  assert.ok(rules.some((r) => r.attribute === 'payment_method'));
});

// --- Collection trigger filters (async ShopifyProduct lookup) ---
const ShopifyProduct = require('../../models/ShopifyProduct');
const originalCountDocuments = ShopifyProduct.countDocuments;

test('collections includes_any matches order in collection', async () => {
  ShopifyProduct.countDocuments = async () => 1;
  try {
    const { match } = await evaluateTriggerRules({
      clientId: 'client_test',
      triggerType: 'order_placed',
      payload: COD_ORDER,
      filters: {
        rules: [{ attribute: 'collections', operator: 'includes_any', value: ['col_hydrogen'] }],
      },
    });
    assert.equal(match, true);
  } finally {
    ShopifyProduct.countDocuments = originalCountDocuments;
  }
});

test('collections_exclude blocks matching collection', async () => {
  ShopifyProduct.countDocuments = async () => 1;
  try {
    const { match } = await evaluateTriggerRules({
      clientId: 'client_test',
      triggerType: 'order_placed',
      payload: COD_ORDER,
      filters: {
        rules: [{ attribute: 'collections_exclude', operator: 'includes_any', value: ['col_hydrogen'] }],
      },
    });
    assert.equal(match, false);
  } finally {
    ShopifyProduct.countDocuments = originalCountDocuments;
  }
});

test('cart_collections matches abandoned cart products', async () => {
  ShopifyProduct.countDocuments = async () => 1;
  try {
    const { match } = await evaluateTriggerRules({
      clientId: 'client_test',
      triggerType: 'cart_abandoned',
      payload: CART_LEAD,
      filters: {
        rules: [{ attribute: 'cart_collections', operator: 'includes_any', value: ['col_sale'] }],
      },
    });
    assert.equal(match, true);
  } finally {
    ShopifyProduct.countDocuments = originalCountDocuments;
  }
});
