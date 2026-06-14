'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePhone,
  formatPhoneForDisplay,
} = require('../../utils/core/helpers');
const {
  buildSyntheticCustomersFromOrders,
  assignOrdersToCustomers,
  applyAssignmentMetrics,
} = require('../../utils/shopify/customerOrderAttribution');

describe('normalizePhone', () => {
  it('keeps Indian 10-digit mobiles as 91-prefixed E.164 digits', () => {
    assert.equal(normalizePhone('9313045439', 'IN'), '919313045439');
    assert.equal(normalizePhone('+919313045439', 'IN'), '919313045439');
  });

  it('does not treat Shopify US test numbers as Indian mobiles', () => {
    assert.equal(normalizePhone('6135550135', 'US'), '16135550135');
    assert.equal(normalizePhone('+16135550135', 'US'), '16135550135');
    assert.equal(normalizePhone('6135550135', 'IN'), '16135550135');
  });

  it('formatPhoneForDisplay shows 10-digit Indian mobiles without country prefix', () => {
    assert.equal(formatPhoneForDisplay('9313045439', 'IN'), '9313045439');
    assert.equal(formatPhoneForDisplay('919313045439', 'IN'), '9313045439');
    assert.equal(formatPhoneForDisplay('+16135550135', 'US'), '+1 613 555 0135');
  });
});

describe('buildSyntheticCustomersFromOrders', () => {
  it('creates buyer profiles from unassigned workspace orders', () => {
    const orders = [
      {
        shopifyOrderId: '1005',
        orderNumber: '1005',
        customerName: 'Moksh Patel',
        customerPhone: '9313045439',
        customerEmail: 'moksh@example.com',
        totalPrice: 750,
        createdAt: new Date('2026-06-14T14:00:00Z'),
      },
    ];
    const synthetics = buildSyntheticCustomersFromOrders(orders);
    assert.equal(synthetics.length, 1);
    assert.equal(synthetics[0].first_name, 'Moksh');
    assert.equal(synthetics[0].phone, '9313045439');
    assert.equal(synthetics[0].source, 'workspace_order');

    const { assignment } = assignOrdersToCustomers(synthetics, orders);
    const withMetrics = applyAssignmentMetrics(synthetics, assignment);
    assert.equal(withMetrics[0].orders_count, 1);
    assert.equal(Number(withMetrics[0].total_spent), 750);
  });
});
