'use strict';

const InventoryLedger = require('../../models/InventoryLedger');
const InventoryLocation = require('../../models/InventoryLocation');
const { applyAdjustment } = require('./ledger');

async function ensureDefaultLocation(clientId) {
  const existing = await InventoryLocation.findOne({ clientId, isDefault: true }).lean();
  if (existing) return existing;
  return InventoryLocation.findOneAndUpdate(
    { clientId, locationId: 'default' },
    {
      $set: {
        clientId,
        locationId: 'default',
        name: 'Default',
        type: 'warehouse',
        isDefault: true,
        isActive: true,
      },
    },
    { upsert: true, new: true }
  );
}

async function getAvailable({ clientId, sku, locationId }) {
  if (locationId) {
    const row = await InventoryLedger.findOne({ clientId, sku, locationId }).lean();
    return row ? Number(row.available) : 0;
  }
  const rows = await InventoryLedger.find({ clientId, sku }).lean();
  return rows.reduce((a, r) => a + (Number(r.available) || 0), 0);
}

async function getAvailableByLocation({ clientId, sku }) {
  const rows = await InventoryLedger.find({ clientId, sku }).lean();
  const map = {};
  for (const r of rows) {
    map[r.locationId || 'default'] = Number(r.available) || 0;
  }
  return map;
}

async function transferStock({
  clientId,
  sku,
  fromLocation,
  toLocation,
  qty,
  idempotencyKey,
  createdBy = {},
}) {
  const n = Number(qty);
  if (n <= 0) throw new Error('qty must be positive');

  const from = await InventoryLedger.findOne({ clientId, sku, locationId: fromLocation });
  if (!from || from.available < n) throw new Error('insufficient_stock');

  const keyBase = idempotencyKey || `xfer:${clientId}:${sku}:${fromLocation}:${toLocation}:${n}:${Date.now()}`;

  await applyAdjustment({
    clientId,
    sku,
    locationId: fromLocation,
    delta: -n,
    reason: 'other',
    reasonNote: `transfer to ${toLocation}`,
    source: 'manual_dashboard',
    sourceRef: keyBase,
    idempotencyKey: `${keyBase}:out`,
    createdBy,
    skipShopifyPush: true,
  });

  await applyAdjustment({
    clientId,
    sku,
    locationId: toLocation,
    delta: n,
    reason: 'other',
    reasonNote: `transfer from ${fromLocation}`,
    source: 'manual_dashboard',
    sourceRef: keyBase,
    idempotencyKey: `${keyBase}:in`,
    createdBy,
    skipShopifyPush: true,
  });

  return getAvailableByLocation({ clientId, sku });
}

module.exports = {
  ensureDefaultLocation,
  getAvailable,
  getAvailableByLocation,
  transferStock,
};
