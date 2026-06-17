'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatLineItemsSummary } = require('../../utils/commerce/orderLineItemEnrichment');

describe('orderLineItemEnrichment', () => {
  it('formatLineItemsSummary joins titles with quantities', () => {
    const out = formatLineItemsSummary([
      { title: 'Smart Doorbell', quantity: 1 },
      { title: 'Chime', quantity: 2 },
    ]);
    assert.equal(out, 'Smart Doorbell × 1, Chime × 2');
  });
});

describe('eco_order_confirmed variable slot 3', () => {
  it('uses order_items not order_total for line-item copy', () => {
    const { ORDER_STATUS_ECO_REGISTRY } = require('../../utils/commerce/orderStatusTemplatePolicy');
    assert.equal(ORDER_STATUS_ECO_REGISTRY.paid.variableMappings.body['3'], 'order_items');
  });
});
