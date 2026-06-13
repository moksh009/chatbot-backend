'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getSpendTier,
  sortCustomers,
  filterCustomers,
  paginateCustomers,
  mergeShopifyCustomersByIdentity,
  mergeCustomersByOrderEvidence,
} = require('../utils/shopify/shopifyCustomersHub');
const {
  assignOrdersToCustomers,
  ordersForCustomerFromAssignment,
} = require('../utils/shopify/customerOrderAttribution');

describe('shopifyCustomersHub', () => {
  const sample = [
    { id: 1, total_spent: '500', orders_count: 2, leadScore: 40, warrantyTotal: 0 },
    { id: 2, total_spent: '15000', orders_count: 8, leadScore: 90, warrantyTotal: 1 },
    { id: 3, total_spent: '8000', orders_count: 4, leadScore: null, warrantyTotal: 0 },
  ];

  it('getSpendTier', () => {
    assert.equal(getSpendTier('12000'), 'vip');
    assert.equal(getSpendTier('6000'), 'regular');
    assert.equal(getSpendTier('100'), 'new');
  });

  it('sortCustomers by spend', () => {
    const sorted = sortCustomers(sample, 'spend');
    assert.equal(sorted[0].id, 2);
  });

  it('filterCustomers tier and topedge', () => {
    const vip = filterCustomers(sample, { tier: 'vip' });
    assert.equal(vip.length, 1);
    const warranty = filterCustomers(sample, { topedge: 'has_warranty' });
    assert.equal(warranty.length, 1);
  });

  it('paginateCustomers cursor', () => {
    const page1 = paginateCustomers(sample, { cursor: null, limit: 2 });
    assert.equal(page1.customers.length, 2);
    assert.equal(page1.hasMore, true);
    const page2 = paginateCustomers(sample, { cursor: page1.nextCursor, limit: 2 });
    assert.equal(page2.customers.length, 1);
    assert.equal(page2.hasMore, false);
  });

  it('mergeShopifyCustomersByIdentity — does not merge Mamta and Moksh on shared phone', () => {
    const shared = '9879095371';
    const raw = [
      { id: '1', first_name: 'Moksh', last_name: 'Patel', phone: shared, email: 'moksh@test.com', total_spent: '100' },
      { id: '2', first_name: 'Mamta', last_name: 'Patel', phone: shared, email: '', total_spent: '50' },
    ];
    const merged = mergeShopifyCustomersByIdentity(raw);
    assert.equal(merged.length, 2);
  });

  it('mergeShopifyCustomersByIdentity — merges Moksh variants with same last name', () => {
    const raw = [
      { id: '1', first_name: 'Moksh', last_name: 'Patel', phone: '9313045439', email: '', total_spent: '100' },
      { id: '2', first_name: 'mOx', last_name: 'Patel', phone: '9879095371', email: 'moksh@test.com', total_spent: '200' },
    ];
    const merged = mergeShopifyCustomersByIdentity(raw);
    assert.equal(merged.length, 1);
    assert.ok(merged[0].mergedCustomerIds.includes('1'));
    assert.ok(merged[0].mergedCustomerIds.includes('2'));
  });

  it('mergeShopifyCustomersByIdentity — merges on shared email', () => {
    const raw = [
      { id: '10', first_name: 'Nakshu', last_name: 'Patel', phone: '9104245084', email: '', total_spent: '100' },
      { id: '11', first_name: 'Nakshu', last_name: 'Patel', phone: '', email: 'nakhujpatel@gmail.com', total_spent: '50' },
    ];
    const merged = mergeShopifyCustomersByIdentity(raw);
    assert.equal(merged.length, 1);
  });

  it('Delitech verification — Moksh excludes Mamta orders; Nakshu single profile with 4 orders', () => {
    const sharedFamilyPhone = '9879095371';
    const rawCustomers = [
      {
        id: 'moksh-987',
        first_name: 'Moksh',
        last_name: 'Patel',
        phone: sharedFamilyPhone,
        email: 'moksh2031@gmail.com',
        linkedPhones: [sharedFamilyPhone],
        linkedEmails: ['moksh2031@gmail.com'],
        total_spent: '50000',
      },
      {
        id: 'moksh-931',
        first_name: 'Moksh',
        last_name: 'Patel',
        phone: '9313045439',
        email: '',
        linkedPhones: ['9313045439'],
        linkedEmails: [],
        total_spent: '10000',
      },
      {
        id: 'mamta',
        first_name: 'Mamta',
        last_name: 'Patel',
        phone: sharedFamilyPhone,
        email: '',
        linkedPhones: [sharedFamilyPhone],
        linkedEmails: [],
        total_spent: '5000',
      },
      {
        id: 'nakshu-phone',
        first_name: 'Nakshu',
        last_name: 'Patel',
        phone: '9104245084',
        email: '',
        linkedPhones: ['9104245084'],
        linkedEmails: [],
        total_spent: '20000',
      },
      {
        id: 'nakshu-email',
        first_name: 'Nakshu',
        last_name: 'Patel',
        phone: '',
        email: 'nakhujpatel@gmail.com',
        linkedEmails: ['nakhujpatel@gmail.com'],
        linkedPhones: [],
        total_spent: '5000',
      },
    ];

    let merged = mergeShopifyCustomersByIdentity(rawCustomers);
    assert.equal(merged.length, 3, 'Moksh variants merge; Mamta stays separate; Nakshu merges on email');

    const orders = [
      {
        _id: 'o1023',
        orderNumber: '1023',
        shopifyCustomerId: 'mamta',
        customerPhone: sharedFamilyPhone,
        customerName: 'Mamta Patel',
        totalPrice: 699,
        createdAt: new Date('2026-03-10'),
      },
      {
        _id: 'o1021',
        orderNumber: '1021',
        shopifyCustomerId: 'mamta',
        customerPhone: sharedFamilyPhone,
        customerName: 'Mamta Patel',
        totalPrice: 599,
        createdAt: new Date('2026-03-08'),
      },
      {
        _id: 'o1026',
        orderNumber: '1026',
        shopifyCustomerId: 'nakshu-phone',
        customerPhone: '9104245084',
        customerEmail: '',
        customerName: 'Nakshu Patel',
        totalPrice: 6999,
        createdAt: new Date('2026-03-09'),
      },
      {
        _id: 'o1019',
        orderNumber: '1019',
        shopifyCustomerId: 'nakshu-email',
        customerPhone: '9104245084',
        customerEmail: 'nakhujpatel@gmail.com',
        customerName: 'Nakshu Patel',
        totalPrice: 6999,
        createdAt: new Date('2026-02-21'),
      },
      {
        _id: 'o1018',
        orderNumber: '1018',
        shopifyCustomerId: 'nakshu-email',
        customerPhone: '9104245084',
        customerEmail: 'nakhujpatel@gmail.com',
        customerName: 'Nakshu Patel',
        totalPrice: 5999,
        createdAt: new Date('2026-02-21'),
      },
      {
        _id: 'o1012',
        orderNumber: '1012',
        shopifyCustomerId: 'nakshu-phone',
        customerPhone: '9104245084',
        customerEmail: '',
        customerName: 'Nakshu Patel',
        totalPrice: 6999,
        createdAt: new Date('2026-02-20'),
      },
      {
        _id: 'o1001',
        orderNumber: '1001',
        shopifyCustomerId: 'moksh-987',
        customerPhone: sharedFamilyPhone,
        customerName: 'Moksh Patel',
        totalPrice: 1299,
        createdAt: new Date('2026-02-01'),
      },
    ];

    let { assignment } = assignOrdersToCustomers(merged, orders);
    const postMerged = mergeCustomersByOrderEvidence(merged, assignment);
    if (postMerged.length < merged.length) {
      merged = postMerged;
      ({ assignment } = assignOrdersToCustomers(merged, orders));
    }

    const mokshProfile = merged.find((c) => c.mergedCustomerIds.includes('moksh-987'));
    const mamtaProfile = merged.find((c) => c.mergedCustomerIds.includes('mamta'));
    const nakshuProfile = merged.find((c) => c.mergedCustomerIds.includes('nakshu-phone'));

    assert.ok(mokshProfile, 'Moksh profile exists');
    assert.ok(mamtaProfile, 'Mamta profile exists');
    assert.ok(nakshuProfile, 'Nakshu profile exists');

    const mokshOrders = ordersForCustomerFromAssignment(mokshProfile.id, assignment);
    const mamtaOrders = ordersForCustomerFromAssignment(mamtaProfile.id, assignment);
    const nakshuOrders = ordersForCustomerFromAssignment(nakshuProfile.id, assignment);

    assert.deepEqual(
      mokshOrders.orders.map((o) => o.orderNumber).sort(),
      ['1001'],
      'Moksh profile excludes Mamta orders #1023 and #1021'
    );
    assert.deepEqual(
      mamtaOrders.orders.map((o) => o.orderNumber).sort(),
      ['1021', '1023'],
      'Mamta profile owns her orders'
    );
    assert.equal(nakshuOrders.orders_count, 4);
    assert.deepEqual(
      nakshuOrders.orders.map((o) => o.orderNumber).sort(),
      ['1012', '1018', '1019', '1026'],
      'Nakshu single profile with 4 unique orders'
    );
  });
});
