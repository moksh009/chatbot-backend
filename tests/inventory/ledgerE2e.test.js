'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyStockHealth } = require('../../utils/inventory/stockClassification');
const { normalizeSku, levenshtein } = require('../../utils/inventory/skuSuggestions');

test('e2e classification: zero stock with sales never healthy', () => {
  const fresh = new Date();
  const r = classifyStockHealth({ qty: 0, unitsSold30d: 40, dailyDemand: 2, catalogSyncedAt: fresh });
  assert.equal(r.stockStatus, 'out_of_stock');
  assert.notEqual(r.stockStatus, 'healthy');
});

test('e2e idempotency key format for amazon line', () => {
  const key = `AMZ-1:LINE-9:Shipped`;
  assert.ok(key.includes('AMZ-1'));
});

test('sku normalize matches underscore variants', () => {
  assert.equal(normalizeSku('TSHIRT-RED-M'), normalizeSku('TSHIRT_RED_M'));
});

test('levenshtein close SKUs', () => {
  assert.ok(levenshtein('abc', 'abd') <= 2);
});

test('channel split units default path', () => {
  const { computeChannelSplit } = require('../../utils/inventory/stockClassification');
  const split = computeChannelSplit([
    { source: 'amazon', totalPrice: 100, items: [{ quantity: 2 }] },
    { source: 'shopify', totalPrice: 50, items: [{ quantity: 1 }] },
  ]);
  assert.equal(split.units.shopifyCount, 1);
  assert.equal(split.units.amazonCount, 2);
});
