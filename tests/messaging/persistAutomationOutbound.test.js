'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('persistAutomationOutbound returns null when tenant or phone missing', async () => {
  const { persistAutomationOutbound } = require('../../utils/messaging/persistAutomationOutbound');

  assert.equal(await persistAutomationOutbound({}), null);
  assert.equal(await persistAutomationOutbound({ clientId: 'tenant_a' }), null);
  assert.equal(await persistAutomationOutbound({ phone: '919999999999' }), null);
});

test('ORDER_STATUS_ECO_REGISTRY available from consolidated orderMessageTemplatePolicy', () => {
  const legacy = require('../../utils/commerce/orderStatusTemplatePolicy');
  const canonical = require('../../utils/commerce/orderMessageTemplatePolicy');

  assert.equal(legacy.ORDER_STATUS_ECO_REGISTRY.paid.templateName, 'eco_order_confirmed');
  assert.deepEqual(
    canonical.ORDER_STATUS_ECO_REGISTRY,
    legacy.ORDER_STATUS_ECO_REGISTRY
  );
});
