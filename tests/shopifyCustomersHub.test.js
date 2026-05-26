'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getSpendTier,
  sortCustomers,
  filterCustomers,
  paginateCustomers,
} = require('../utils/shopify/shopifyCustomersHub');

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
});
