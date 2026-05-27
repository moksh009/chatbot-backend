'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSuccessfulOrderMatch,
  buildCustomerLtvOrderMatch,
  orderRevenue,
  EXCLUDE_ORDER_STATUSES,
} = require('../utils/commerce/customerOrderMetrics');

function orderPassesMongoMatch(match, order) {
  if (match.clientId && match.clientId !== order.clientId) return false;
  if (match.status?.$nin?.includes(order.status)) return false;
  if (match.financialStatus?.$nin?.includes(order.financialStatus)) return false;
  if (match.$and) {
    for (const clause of match.$and) {
      if (clause.status?.$nin?.includes(order.status)) return false;
      if (clause.financialStatus?.$nin?.includes(order.financialStatus)) return false;
      if (clause.$or) {
        const ok = clause.$or.some((branch) => {
          if (branch.financialStatus?.$in?.includes(order.financialStatus)) return true;
          if (branch.status?.$in?.includes(order.status)) return true;
          return false;
        });
        if (!ok) return false;
      }
    }
  }
  return true;
}

test('COD pending Shopify orders count toward LTV match', () => {
  const clientId = 'tenant-1';
  const codPending = {
    clientId,
    status: 'pending',
    financialStatus: 'pending',
    totalPrice: 2499,
  };

  const ltvMatch = buildCustomerLtvOrderMatch(clientId);
  const strictMatch = buildSuccessfulOrderMatch(clientId);

  assert.equal(orderRevenue(codPending), 2499);
  assert.equal(orderPassesMongoMatch(ltvMatch, codPending), true);
  assert.equal(orderPassesMongoMatch(strictMatch, codPending), false);
});

test('cancelled orders are excluded from LTV match', () => {
  const clientId = 'tenant-1';
  const cancelled = {
    clientId,
    status: 'cancelled',
    financialStatus: 'voided',
    totalPrice: 999,
  };
  const ltvMatch = buildCustomerLtvOrderMatch(clientId);
  assert.equal(orderPassesMongoMatch(ltvMatch, cancelled), false);
  assert.ok(EXCLUDE_ORDER_STATUSES.includes('cancelled'));
});
