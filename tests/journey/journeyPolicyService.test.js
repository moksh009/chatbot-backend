'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkMinOrderValue,
  orderAmountFromPayload,
} = require('../../services/journeyBuilder/journeyPolicyService');

test('orderAmountFromPayload parses total_price', () => {
  assert.equal(orderAmountFromPayload({ total_price: '1299.00' }), 1299);
  assert.equal(orderAmountFromPayload({}), null);
});

test('checkMinOrderValue allows above threshold', () => {
  const ok = checkMinOrderValue({
    policies: { minOrderValue: 500 },
    orderPayload: { total_price: '1200' },
    triggerType: 'order_placed',
  });
  assert.equal(ok.allowed, true);
});

test('checkMinOrderValue blocks below threshold', () => {
  const bad = checkMinOrderValue({
    policies: { minOrderValue: 500 },
    orderPayload: { total_price: '99' },
    triggerType: 'order_placed',
  });
  assert.equal(bad.allowed, false);
  assert.equal(bad.reason, 'min_order_value');
});

test('checkMinOrderValue ignored for cart triggers', () => {
  const ok = checkMinOrderValue({
    policies: { minOrderValue: 500 },
    orderPayload: { total_price: '99' },
    triggerType: 'cart_abandoned',
  });
  assert.equal(ok.allowed, true);
});

test('max enrollments policy does not apply to order_placed triggers', async () => {
  const { checkMaxEnrollments } = require('../../services/journeyBuilder/journeyPolicyService');
  const ok = await checkMaxEnrollments({
    clientId: 'delitech_smarthomes',
    flowId: 'journey_test',
    leadId: '507f1f77bcf86cd799439011',
    policies: { maxEnrollmentsPerLead: 1 },
    triggerType: 'order_placed',
  });
  assert.equal(ok.allowed, true);
});
