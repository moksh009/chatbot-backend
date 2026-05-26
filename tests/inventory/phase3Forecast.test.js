'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeVelocityBlend,
  computeConfidence,
  computeDepletion,
  detectTrend,
} = require('../../utils/inventory/forecastModel');
const { computeReorderPoint, computeUrgency } = require('../../utils/inventory/restockRules');

function mockOrders(sku, days, unitsPerDay) {
  const orders = [];
  const now = Date.now();
  for (let d = 0; d < days; d++) {
    orders.push({
      createdAt: new Date(now - d * 24 * 60 * 60 * 1000),
      source: 'shopify',
      items: [{ sku, quantity: unitsPerDay }],
      totalPrice: 100,
    });
  }
  return orders;
}

test('computeReorderPoint: (14+7)*5 = 105', () => {
  const rule = { leadTimeDays: 14, safetyStockDays: 7 };
  assert.equal(computeReorderPoint(rule, 5), 105);
});

test('computeUrgency: critical when stock at 3 days velocity', () => {
  const rule = { criticalDays: 3, lowDays: 7, leadTimeDays: 14, safetyStockDays: 7 };
  const u = computeUrgency(12, 0, 5, rule);
  assert.equal(u.urgency, 'urgent');
});

test('forecast: 30d history yields medium+ confidence', () => {
  const orders = mockOrders('SKU-A', 35, 2);
  const blend = computeVelocityBlend(orders, 'SKU-A');
  const conf = computeConfidence(orders, 'SKU-A', blend);
  assert.ok(conf.score >= 34);
});

test('computeDepletion applies low-confidence penalty', () => {
  const high = computeDepletion(100, 5, 'high');
  const low = computeDepletion(100, 5, 'low');
  assert.ok(low.days < high.days);
});

test('detectTrend flags velocity spike', () => {
  const orders = [];
  const now = Date.now();
  for (let d = 8; d < 30; d++) {
    orders.push({
      createdAt: new Date(now - d * 86400000),
      items: [{ sku: 'X', quantity: 1 }],
    });
  }
  for (let d = 0; d < 7; d++) {
    orders.push({
      createdAt: new Date(now - d * 86400000),
      items: [{ sku: 'X', quantity: 10 }],
    });
  }
  const t = detectTrend(orders, 'X');
  assert.equal(t.trend, 'up');
});
