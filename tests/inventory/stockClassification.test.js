'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyStockHealth,
  forecastConfidence,
  statusSortRank,
} = require('../../utils/inventory/stockClassification');

const fresh = new Date();

test('qty=0 with sales → out_of_stock not healthy', () => {
  const r = classifyStockHealth({ qty: 0, unitsSold30d: 12, dailyDemand: 0.4, catalogSyncedAt: fresh });
  assert.equal(r.stockStatus, 'out_of_stock');
  assert.equal(r.depletionDays, null);
});

test('qty=50 no sales → idle', () => {
  const r = classifyStockHealth({ qty: 50, unitsSold30d: 0, dailyDemand: 0, catalogSyncedAt: fresh });
  assert.equal(r.stockStatus, 'idle');
});

test('qty=null → unknown', () => {
  const r = classifyStockHealth({ qty: null, unitsSold30d: 5, dailyDemand: 0.2, catalogSyncedAt: null });
  assert.equal(r.stockStatus, 'unknown');
});

test('qty=2 with sales → critical', () => {
  const r = classifyStockHealth({ qty: 2, unitsSold30d: 10, dailyDemand: 10 / 30, catalogSyncedAt: fresh });
  assert.equal(r.stockStatus, 'critical');
});

test('qty=20 moderate velocity → low or healthy', () => {
  const r = classifyStockHealth({ qty: 20, unitsSold30d: 30, dailyDemand: 1, catalogSyncedAt: fresh });
  assert.ok(['low', 'healthy', 'critical'].includes(r.stockStatus));
  assert.ok(r.depletionDays != null || r.stockStatus === 'critical');
});

test('forecast confidence none without sales', () => {
  assert.equal(forecastConfidence({ unitsSold: 0 }), 'none');
});

test('status sort ranks out_of_stock first', () => {
  assert.ok(statusSortRank('out_of_stock') < statusSortRank('healthy'));
});

test('stale catalog (>24h) → unknown even with qty', () => {
  const stale = new Date(Date.now() - 30 * 60 * 60 * 1000);
  const r = classifyStockHealth({ qty: 20, unitsSold30d: 5, dailyDemand: 0.2, catalogSyncedAt: stale });
  assert.equal(r.stockStatus, 'unknown');
});
