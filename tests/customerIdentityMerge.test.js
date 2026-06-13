'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dedupeOrdersByShopifyKey } = require('../utils/shopify/orderDedupe');
const {
  mergeShopifyCustomersByIdentity,
  ordersForCustomer,
  buildCustomerOrderIndex,
} = require('../utils/shopify/customerIdentityMerge');

describe('orderDedupe', () => {
  it('merges prepaid + COD rows with same order number', () => {
    const raw = [
      {
        _id: 'a',
        orderNumber: '1034',
        shopifyOrderId: '999',
        financialStatus: 'paid',
        createdAt: '2026-04-16T10:00:00Z',
      },
      {
        _id: 'b',
        orderNumber: '#1034',
        customerName: 'Tilva Smit',
        shippingAddress: { city: 'Ahmedabad', address1: 'Main St' },
        financialStatus: 'pending',
        isCOD: true,
        createdAt: '2026-04-16T09:59:00Z',
      },
    ];
    const out = dedupeOrdersByShopifyKey(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0]._id, 'b');
  });
});

describe('customerIdentityMerge', () => {
  it('merges customers with same phone suffix', () => {
    const merged = mergeShopifyCustomersByIdentity([
      { id: 1, first_name: 'Moksh', last_name: 'Patel', phone: '+919313045439', email: 'a@x.com', total_spent: '100' },
      { id: 2, first_name: 'm0x', last_name: 'Patel', phone: '9313045439', email: '', total_spent: '200' },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].mergedCustomerIds.length, 2);
  });

  it('merges customers with same email', () => {
    const merged = mergeShopifyCustomersByIdentity([
      { id: 1, first_name: 'Tilva', phone: '919484607042', email: 'tilva@x.com', total_spent: '100' },
      { id: 2, first_name: 'Tilva Smit', phone: '9484607042', email: 'tilva@x.com', total_spent: '200' },
    ]);
    assert.equal(merged.length, 1);
  });

  it('counts unique orders across linked phones', () => {
    const customer = {
      id: '1',
      phone: '9313045439',
      linkedPhones: ['9313045439', '9879095371'],
      linkedEmails: [],
    };
    const orders = [
      { orderNumber: '1020', phone: '9879095371', totalPrice: 6999, createdAt: '2026-02-22' },
      { orderNumber: '1021', phone: '9879095371', totalPrice: 799, createdAt: '2026-03-04' },
      { orderNumber: '1029', customerPhone: '9313045439', totalPrice: 6999, createdAt: '2026-03-25' },
      { orderNumber: '1030', customerPhone: '9313045439', totalPrice: 6499, createdAt: '2026-03-25' },
      { orderNumber: '1029', shopifyOrderId: 'x', totalPrice: 6999, createdAt: '2026-03-25' },
    ];
    const index = buildCustomerOrderIndex(orders);
    const metrics = ordersForCustomer(customer, index);
    assert.equal(metrics.orders_count, 4);
  });
});
