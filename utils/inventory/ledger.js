'use strict';

const InventoryAdjustment = require('../../models/InventoryAdjustment');
const InventoryLedger = require('../../models/InventoryLedger');
const ShopifyProduct = require('../../models/ShopifyProduct');
const SkuMapping = require('../../models/SkuMapping');
const { auditLog } = require('../../services/audit/auditWriter');
const { queueShopifyInventoryPush } = require('../messaging/queues/inventoryShopifyPushQueue');
const { queueAmazonInventoryPush } = require('../messaging/queues/inventoryAmazonPushQueue');
const { alertStockout } = require('./inventoryAlerts');
const log = require('../core/logger')('InventoryLedger');

async function getCatalogQty(clientId, sku) {
  const row = await ShopifyProduct.findOne({ clientId, sku }).select('inventoryQuantity').lean();
  if (row) return Number(row.inventoryQuantity) || 0;
  const anySku = await ShopifyProduct.findOne({
    clientId,
    $or: [{ sku }, { shopifyVariantId: sku }],
  })
    .select('inventoryQuantity sku')
    .lean();
  return anySku ? Number(anySku.inventoryQuantity) || 0 : 0;
}

async function resolveInternalSku(clientId, { sku, shopifyVariantId, amazonSellerSku }) {
  if (sku) {
    const byInternal = await SkuMapping.findOne({ clientId, internalSku: sku }).lean();
    if (byInternal) return byInternal.internalSku;
  }
  if (amazonSellerSku) {
    const m = await SkuMapping.findOne({ clientId, 'amazon.sellerSku': amazonSellerSku }).lean();
    if (m) return m.internalSku;
  }
  if (shopifyVariantId) {
    const m = await SkuMapping.findOne({ clientId, 'shopify.variantId': String(shopifyVariantId) }).lean();
    if (m) return m.internalSku;
  }
  if (sku) {
    const m = await SkuMapping.findOne({ clientId, 'shopify.sku': sku }).lean();
    if (m) return m.internalSku;
    return sku;
  }
  return null;
}

/**
 * Event-sourced adjustment with idempotent cache update.
 */
async function applyAdjustment({
  clientId,
  sku,
  locationId = 'default',
  delta,
  reason = 'other',
  reasonNote = '',
  source = 'manual_dashboard',
  sourceRef = '',
  idempotencyKey,
  createdBy = {},
  audit = {},
  skipShopifyPush = false,
}) {
  if (!clientId || !sku || !idempotencyKey) {
    throw new Error('clientId, sku, and idempotencyKey are required');
  }

  const existing = await InventoryAdjustment.findOne({ clientId, idempotencyKey }).lean();
  if (existing) return { adjustment: existing, duplicate: true };

  const internalSku = await resolveInternalSku(clientId, { sku });
  const ledgerSku = internalSku || sku;

  let ledger = await InventoryLedger.findOne({ clientId, sku: ledgerSku, locationId });
  if (!ledger) {
    const baseline = await getCatalogQty(clientId, ledgerSku);
    ledger = await InventoryLedger.create({
      clientId,
      sku: ledgerSku,
      locationId,
      available: baseline,
      reserved: 0,
      onOrder: 0,
      lastShopifySync: { at: new Date(), qty: baseline },
    });
  }

  const qtyBefore = Number(ledger.available) || 0;
  const qtyAfter = qtyBefore + Number(delta);

  ledger.available = qtyAfter;
  ledger.lastAdjustmentAt = new Date();
  await ledger.save();

  let adjustment;
  try {
    adjustment = await InventoryAdjustment.create({
      clientId,
      sku: ledgerSku,
      locationId,
      delta: Number(delta),
      reason,
      reasonNote,
      idempotencyKey,
      source,
      sourceRef,
      qtyBefore,
      qtyAfter,
      createdBy,
      audit,
      syncStatus: skipShopifyPush ? 'synced' : 'pending',
    });
  } catch (err) {
    if (err.code === 11000) {
      const dup = await InventoryAdjustment.findOne({ clientId, idempotencyKey }).lean();
      return { adjustment: dup, duplicate: true };
    }
    throw err;
  }

  ledger.lastAdjustmentId = adjustment._id;
  await ledger.save();

  await ShopifyProduct.updateMany(
    { clientId, sku: ledgerSku },
    { $set: { inventoryQuantity: qtyAfter, inStock: qtyAfter > 0, lastSyncedAt: new Date() } }
  );

  if (!skipShopifyPush && source !== 'shopify_webhook') {
    const product = await ShopifyProduct.findOne({ clientId, sku: ledgerSku })
      .select('shopifyInventoryItemId shopifyVariantId title')
      .lean();
    await queueShopifyInventoryPush({
      clientId,
      sku: ledgerSku,
      locationId,
      available: qtyAfter,
      inventoryItemId: product?.shopifyInventoryItemId || null,
      adjustmentId: String(adjustment._id),
    });
  }

  if (qtyBefore > 0 && qtyAfter <= 0) {
    const product = await ShopifyProduct.findOne({ clientId, sku: ledgerSku }).select('title').lean();
    alertStockout(clientId, ledgerSku, product?.title).catch(() => {});
  }

  const { onStockChange } = require('./stockoutTracker');
  onStockChange({
    clientId,
    sku: ledgerSku,
    locationId,
    qtyBefore,
    qtyAfter,
    channels: ['shopify'],
  }).catch(() => {});

  if (Number(delta) > 0 && qtyAfter > 0) {
    const { fulfillBackordersFifo } = require('./backorderHandler');
    fulfillBackordersFifo({ clientId, sku: ledgerSku, incomingQty: delta }).catch(() => {});
  }

  await maybeQueueAmazonPush(clientId, ledgerSku, qtyAfter);

  auditLog({
    category: 'inventory',
    action: 'inventory.adjusted',
    clientId,
    details: {
      sku: ledgerSku,
      delta,
      qtyBefore,
      qtyAfter,
      reason,
      source,
      sourceRef,
      idempotencyKey,
    },
  }).catch((e) => log.warn(`audit failed: ${e.message}`));

  return { adjustment, ledger, duplicate: false };
}

async function reserveStock({
  clientId,
  sku,
  locationId = 'default',
  qty,
  source,
  sourceRef,
  idempotencyKey,
}) {
  const existing = await InventoryAdjustment.findOne({ clientId, idempotencyKey }).lean();
  if (existing) return { adjustment: existing, duplicate: true };

  const ledger = await InventoryLedger.findOne({ clientId, sku, locationId });
  if (!ledger || ledger.available < qty) {
    return { error: 'insufficient_stock', available: ledger?.available ?? 0 };
  }

  ledger.available -= qty;
  ledger.reserved = (ledger.reserved || 0) + qty;
  await ledger.save();

  const adjustment = await InventoryAdjustment.create({
    clientId,
    sku,
    locationId,
    delta: -qty,
    reason: 'other',
    reasonNote: 'reservation',
    idempotencyKey,
    source,
    sourceRef,
    qtyBefore: ledger.available + qty,
    qtyAfter: ledger.available,
    syncStatus: 'synced',
  });

  return { adjustment, ledger, duplicate: false };
}

async function releaseReservation({
  clientId,
  sku,
  locationId = 'default',
  qty,
  source,
  sourceRef,
  idempotencyKey,
}) {
  const existing = await InventoryAdjustment.findOne({ clientId, idempotencyKey }).lean();
  if (existing) return { adjustment: existing, duplicate: true };

  const ledger = await InventoryLedger.findOne({ clientId, sku, locationId });
  if (!ledger) return { error: 'ledger_not_found' };

  const releaseQty = Math.min(qty, ledger.reserved || 0);
  ledger.reserved = Math.max(0, (ledger.reserved || 0) - releaseQty);
  ledger.available += releaseQty;
  await ledger.save();

  const adjustment = await InventoryAdjustment.create({
    clientId,
    sku,
    locationId,
    delta: releaseQty,
    reason: 'return',
    reasonNote: 'reservation_release',
    idempotencyKey,
    source,
    sourceRef,
    qtyBefore: ledger.available - releaseQty,
    qtyAfter: ledger.available,
    syncStatus: 'synced',
  });

  return { adjustment, ledger, duplicate: false };
}

async function confirmReservation({
  clientId,
  sku,
  locationId = 'default',
  qty,
  source,
  sourceRef,
  idempotencyKey,
}) {
  const existing = await InventoryAdjustment.findOne({ clientId, idempotencyKey }).lean();
  if (existing) return { adjustment: existing, duplicate: true };

  const ledger = await InventoryLedger.findOne({ clientId, sku, locationId });
  if (!ledger) return { error: 'ledger_not_found' };

  const commitQty = Math.min(qty, ledger.reserved || 0);
  ledger.reserved = Math.max(0, (ledger.reserved || 0) - commitQty);
  await ledger.save();

  const adjustment = await InventoryAdjustment.create({
    clientId,
    sku,
    locationId,
    delta: 0,
    reason: 'other',
    reasonNote: 'reservation_confirmed',
    idempotencyKey,
    source,
    sourceRef,
    qtyBefore: ledger.available,
    qtyAfter: ledger.available,
    syncStatus: 'synced',
  });

  return { adjustment, ledger, duplicate: false };
}

async function maybeQueueAmazonPush(clientId, internalSku, available) {
  const mapping = await SkuMapping.findOne({ clientId, internalSku }).lean();
  if (!mapping?.amazon?.sellerSku) return;
  if (mapping.amazon.fulfillment === 'fba') return;
  await queueAmazonInventoryPush({
    clientId,
    sku: internalSku,
    sellerSku: mapping.amazon.sellerSku,
    quantity: available,
  });
}

/**
 * Apply ledger adjustments for past Amazon orders after a new SKU mapping is verified.
 */
async function applyRetroactiveAmazonOrders(clientId, internalSku, amazonSellerSku) {
  const Order = require('../../models/Order');
  const orders = await Order.find({
    clientId,
    source: 'amazon',
    'items.sku': amazonSellerSku,
  })
    .select('orderId items status')
    .lean();

  let applied = 0;
  for (const order of orders) {
    for (const item of order.items || []) {
      if (item.sku !== amazonSellerSku) continue;
      const qty = Number(item.quantity) || 1;
      const lineId = item.lineItemId || item.sku;
      const key = `retro:${order.orderId}:${lineId}`;
      const existing = await InventoryAdjustment.findOne({ clientId, idempotencyKey: key }).lean();
      if (existing) continue;
      await applyAdjustment({
        clientId,
        sku: internalSku,
        delta: -qty,
        reason: 'correction',
        source: 'amazon_order',
        sourceRef: order.orderId,
        idempotencyKey: key,
        skipShopifyPush: false,
      });
      applied += 1;
    }
  }
  return { applied };
}

async function autoMatchSkuMapping(clientId, amazonSellerSku) {
  const existing = await SkuMapping.findOne({ clientId, 'amazon.sellerSku': amazonSellerSku }).lean();
  if (existing) return existing;

  const shopifyRow = await ShopifyProduct.findOne({ clientId, sku: amazonSellerSku }).lean();
  if (shopifyRow) {
    return SkuMapping.findOneAndUpdate(
      { clientId, internalSku: amazonSellerSku },
      {
        $set: {
          shopify: {
            productId: shopifyRow.shopifyProductId,
            variantId: shopifyRow.shopifyVariantId,
            sku: shopifyRow.sku,
            locationIds: ['default'],
          },
          amazon: { sellerSku: amazonSellerSku, fulfillment: 'merchant' },
          mappingSource: 'auto',
          confidence: 95,
        },
      },
      { upsert: true, new: true }
    );
  }

  const normalized = amazonSellerSku.replace(/[-_\s]/g, '').toLowerCase();
  const candidates = await ShopifyProduct.find({ clientId }).select('sku shopifyProductId shopifyVariantId').lean();
  for (const c of candidates) {
    const n = String(c.sku || '').replace(/[-_\s]/g, '').toLowerCase();
    if (n && n === normalized) {
      return SkuMapping.findOneAndUpdate(
        { clientId, internalSku: c.sku || amazonSellerSku },
        {
          $set: {
            shopify: {
              productId: c.shopifyProductId,
              variantId: c.shopifyVariantId,
              sku: c.sku,
              locationIds: ['default'],
            },
            amazon: { sellerSku: amazonSellerSku, fulfillment: 'merchant' },
            mappingSource: 'auto',
            confidence: 60,
          },
        },
        { upsert: true, new: true }
      );
    }
  }

  return null;
}

module.exports = {
  applyAdjustment,
  reserveStock,
  releaseReservation,
  confirmReservation,
  autoMatchSkuMapping,
  applyRetroactiveAmazonOrders,
  maybeQueueAmazonPush,
  resolveInternalSku,
  getCatalogQty,
};
