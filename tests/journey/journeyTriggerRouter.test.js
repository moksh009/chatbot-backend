'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateTriggerRules } = require('../../services/journeyBuilder/journeyTriggerEvaluator');
const { journeyTriggerSummary } = require('../../services/journeyBuilder/journeyNodeContract');
const { defaultRulesForEvent, summarizeTriggerRules } = require('../../services/journeyBuilder/triggerFilterCatalog');

test('filter_mismatch path rejects prepaid when blueprint requires COD', async () => {
  const { match, reason } = await evaluateTriggerRules({
    clientId: 'client_test',
    triggerType: 'order_placed',
    payload: {
      name: '#100',
      total_price: '500',
      payment_gateway_names: ['razorpay'],
      line_items: [],
    },
    filters: {
      rules: [{ attribute: 'payment_method', operator: 'is', value: 'cod' }],
    },
  });
  assert.equal(match, false);
  assert.equal(reason, 'payment_method_mismatch');
});

test('empty filters match all orders (default opt-in)', async () => {
  const { match } = await evaluateTriggerRules({
    clientId: 'client_test',
    triggerType: 'order_placed',
    payload: { total_price: '100', line_items: [] },
    filters: {},
  });
  assert.equal(match, true);
});

test('publish-shaped journeyTrigger summary — All orders', () => {
  const label = journeyTriggerSummary({
    type: 'order_placed',
    filters: { rules: [] },
  });
  assert.match(label, /All orders/);
});

test('publish-shaped journeyTrigger summary — cart delay default', () => {
  const rules = defaultRulesForEvent('cart_abandoned');
  const label = journeyTriggerSummary({
    type: 'cart_abandoned',
    filters: { rules },
  });
  assert.match(label, /All carts after 25m/);
  assert.deepEqual(summarizeTriggerRules(rules, 'cart_abandoned'), ['All carts after 25m']);
});
