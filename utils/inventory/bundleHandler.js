'use strict';

const BundleDefinition = require('../../models/BundleDefinition');
const InventoryLedger = require('../../models/InventoryLedger');
const { applyAdjustment } = require('./ledger');

async function getBundleAvailability(clientId, bundleSku) {
  const def = await BundleDefinition.findOne({ clientId, bundleSku }).lean();
  if (!def?.components?.length) return { available: 0, limitingComponent: null };

  let minBundles = Infinity;
  let limiting = null;
  for (const c of def.components) {
    const ledger = await InventoryLedger.findOne({
      clientId,
      sku: c.componentSku,
      locationId: 'default',
    }).lean();
    const avail = ledger ? Number(ledger.available) : 0;
    const bundles = Math.floor(avail / (Number(c.quantity) || 1));
    if (bundles < minBundles) {
      minBundles = bundles;
      limiting = c.componentSku;
    }
  }
  return {
    available: minBundles === Infinity ? 0 : minBundles,
    limitingComponent: limiting,
    isVirtual: def.isVirtual,
  };
}

async function applyBundleOrderDecrement({
  clientId,
  bundleSku,
  orderQty,
  orderId,
  lineItemId,
}) {
  const def = await BundleDefinition.findOne({ clientId, bundleSku }).lean();
  if (!def) return { applied: false, reason: 'not_a_bundle' };

  const results = [];
  for (const c of def.components) {
    const delta = -(Number(orderQty) || 1) * (Number(c.quantity) || 1);
    const key = `${orderId}:${lineItemId}:${c.componentSku}`;
    const r = await applyAdjustment({
      clientId,
      sku: c.componentSku,
      delta,
      reason: 'other',
      reasonNote: `bundle ${bundleSku}`,
      source: 'shopify_order',
      sourceRef: orderId,
      idempotencyKey: key,
    });
    results.push(r);
  }
  return { applied: true, results };
}

module.exports = { getBundleAvailability, applyBundleOrderDecrement };
