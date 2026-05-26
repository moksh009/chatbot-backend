'use strict';

const InventoryLedger = require('../../models/InventoryLedger');
const ShopifyProduct = require('../../models/ShopifyProduct');
const AmazonInventorySnapshot = require('../../models/AmazonInventorySnapshot');
const SkuMapping = require('../../models/SkuMapping');

const DRIFT_THRESHOLD = Number(process.env.INVENTORY_DRIFT_THRESHOLD || 5);
const STALE_MS = 6 * 60 * 60 * 1000;
const VERY_STALE_MS = 24 * 60 * 60 * 1000;

function syncFreshness(lastAt) {
  if (!lastAt) return { label: 'unknown', stale: true, veryStale: true };
  const age = Date.now() - new Date(lastAt).getTime();
  return {
    label: age < STALE_MS ? 'live' : age < VERY_STALE_MS ? 'stale' : 'very_stale',
    stale: age >= STALE_MS,
    veryStale: age >= VERY_STALE_MS,
    ageMs: age,
  };
}

/**
 * Per internal SKU channel quantities + drift flags.
 */
async function getChannelInventoryView(clientId, internalSku) {
  const mapping = await SkuMapping.findOne({ clientId, internalSku }).lean();
  const ledger = await InventoryLedger.findOne({ clientId, sku: internalSku, locationId: 'default' }).lean();
  const shopify = await ShopifyProduct.findOne({ clientId, sku: internalSku })
    .select('inventoryQuantity lastSyncedAt title')
    .lean();

  let amazon = null;
  if (mapping?.amazon?.sellerSku) {
    amazon = await AmazonInventorySnapshot.findOne({
      clientId,
      sellerSku: mapping.amazon.sellerSku,
    }).lean();
  }

  const ledgerQty = ledger ? Number(ledger.available) : null;
  const shopifyQty = shopify ? Number(shopify.inventoryQuantity) : null;
  const amazonQty = amazon ? Number(amazon.totalSellable) : null;

  const parts = [ledgerQty, shopifyQty, amazonQty].filter((q) => q != null);
  const max = parts.length ? Math.max(...parts) : 0;
  const min = parts.length ? Math.min(...parts) : 0;
  const drift = parts.length >= 2 && max - min >= DRIFT_THRESHOLD;

  return {
    internalSku,
    mapping,
    ledger: ledgerQty,
    reserved: ledger?.reserved ?? 0,
    shopify: {
      qty: shopifyQty,
      ...syncFreshness(shopify?.lastSyncedAt),
      lastSyncedAt: shopify?.lastSyncedAt,
    },
    amazon: amazon
      ? {
          totalSellable: amazonQty,
          fba: amazon.fba,
          merchantFulfilled: amazon.merchantFulfilled,
          ...syncFreshness(amazon.lastSyncedAt),
          lastSyncedAt: amazon.lastSyncedAt,
          lastSyncError: amazon.lastSyncError,
        }
      : null,
    combinedSellable:
      (shopifyQty ?? 0) > 0 || (amazonQty ?? 0) > 0
        ? Math.max(shopifyQty ?? 0, amazonQty ?? 0)
        : ledgerQty,
    drift,
    driftMagnitude: drift ? max - min : 0,
    truthSource: mapping?.truthSource || 'ledger',
  };
}

async function listDriftSkus(clientId, { limit = 50 } = {}) {
  const mappings = await SkuMapping.find({ clientId }).limit(500).lean();
  const drifts = [];
  for (const m of mappings) {
    const view = await getChannelInventoryView(clientId, m.internalSku);
    if (view.drift) drifts.push(view);
    if (drifts.length >= limit) break;
  }
  return drifts;
}

module.exports = {
  getChannelInventoryView,
  listDriftSkus,
  DRIFT_THRESHOLD,
  syncFreshness,
};
