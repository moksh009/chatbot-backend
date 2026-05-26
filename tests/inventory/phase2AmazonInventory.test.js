'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeTotalSellable } = require('../../utils/inventory/amazonInventorySync');
const { authoritativeQty } = require('../../utils/inventory/truthSourceReconciliation');
const { DRIFT_THRESHOLD } = require('../../utils/inventory/channelDrift');
const AmazonSPAPI = require('../../utils/commerce/amazonSPAPI');

test('computeTotalSellable: FBA + merchant-fulfilled', () => {
  const total = computeTotalSellable(
    { fulfillable: 45 },
    { quantity: 23 }
  );
  assert.equal(total, 68);
});

test('computeTotalSellable: FBA only when MF unknown', () => {
  assert.equal(computeTotalSellable({ fulfillable: 12 }, null), 12);
});

test('parseFbaSummaryRow extracts breakdown', () => {
  const row = AmazonSPAPI.parseFbaSummaryRow({
    sellerSku: 'SKU-1',
    asin: 'B001',
    inventoryDetails: {
      fulfillableQuantity: 10,
      inboundWorkingQuantity: 1,
      inboundShippedQuantity: 2,
      inboundReceivingQuantity: 3,
      reservedQuantity: 4,
      unfulfillableQuantity: 5,
      researchingQuantity: 0,
    },
    totalQuantity: 25,
  });
  assert.equal(row.sellerSku, 'SKU-1');
  assert.equal(row.fba.fulfillable, 10);
  assert.equal(row.fba.inbound.working, 1);
  assert.equal(row.fba.reserved, 4);
});

test('authoritativeQty respects truthSource', () => {
  const view = {
    ledger: 47,
    shopify: { qty: 50 },
    amazon: { totalSellable: 12, fba: { fulfillable: 10 } },
  };
  assert.equal(authoritativeQty(view, 'ledger'), 47);
  assert.equal(authoritativeQty(view, 'shopify'), 50);
  assert.equal(authoritativeQty(view, 'amazon_fba'), 10);
  assert.equal(authoritativeQty(view, 'amazon_combined'), 12);
});

test('drift threshold default is at least 1', () => {
  assert.ok(DRIFT_THRESHOLD >= 1);
});

test('drift detected when channel spread exceeds threshold', () => {
  const parts = [47, 50, 12];
  const max = Math.max(...parts);
  const min = Math.min(...parts);
  const drift = max - min >= DRIFT_THRESHOLD;
  assert.equal(drift, true);
});
