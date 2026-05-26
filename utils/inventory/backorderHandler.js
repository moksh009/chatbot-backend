'use strict';

const BackorderRule = require('../../models/BackorderRule');
const InventoryLedger = require('../../models/InventoryLedger');
const InventoryAdjustment = require('../../models/InventoryAdjustment');

async function recordBackorder({ clientId, sku, qty, orderId, lineItemId }) {
  const rule = await BackorderRule.findOne({ clientId, sku, allowBackorder: true }).lean();
  if (!rule) return { allowed: false };

  const max = rule.maxBackorderQty;
  let ledger = await InventoryLedger.findOne({ clientId, sku, locationId: 'default' });
  if (!ledger) {
    ledger = await InventoryLedger.create({
      clientId,
      sku,
      locationId: 'default',
      available: 0,
      reserved: 0,
      onOrder: 0,
      backorder: 0,
    });
  }

  const nextBackorder = (ledger.backorder || 0) + qty;
  if (max != null && nextBackorder > max) {
    return { allowed: false, reason: 'max_backorder_exceeded' };
  }

  const key = `backorder:${orderId}:${lineItemId}`;
  const existing = await InventoryAdjustment.findOne({ clientId, idempotencyKey: key }).lean();
  if (existing) return { allowed: true, duplicate: true };

  ledger.backorder = nextBackorder;
  await ledger.save();

  await InventoryAdjustment.create({
    clientId,
    sku,
    locationId: 'default',
    delta: 0,
    reason: 'other',
    reasonNote: `backorder +${qty}`,
    idempotencyKey: key,
    source: 'shopify_order',
    sourceRef: orderId,
    qtyBefore: ledger.available,
    qtyAfter: ledger.available,
    syncStatus: 'synced',
  });

  return { allowed: true, backorder: nextBackorder };
}

async function fulfillBackordersFifo({ clientId, sku, incomingQty }) {
  let ledger = await InventoryLedger.findOne({ clientId, sku, locationId: 'default' });
  if (!ledger || !ledger.backorder) return { fulfilled: 0 };

  const fulfill = Math.min(Number(incomingQty) || 0, ledger.backorder);
  ledger.backorder = Math.max(0, ledger.backorder - fulfill);
  await ledger.save();
  return { fulfilled: fulfill, remainingBackorder: ledger.backorder };
}

module.exports = { recordBackorder, fulfillBackordersFifo };
