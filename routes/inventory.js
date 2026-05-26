'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { protect, verifyClientAccess, authorize } = require('../middleware/auth');
const ShopifyProduct = require('../models/ShopifyProduct');
const InventoryAdjustment = require('../models/InventoryAdjustment');
const InventoryLedger = require('../models/InventoryLedger');
const SkuMapping = require('../models/SkuMapping');
const Order = require('../models/Order');
const Client = require('../models/Client');
const { applyAdjustment, applyRetroactiveAmazonOrders } = require('../utils/inventory/ledger');
const { INVENTORY_ADJUSTMENT_REASONS } = require('../models/InventoryAdjustment');
const { suggestMappings, listUnmappedSkus } = require('../utils/inventory/skuSuggestions');
const { reconcileClientInventory } = require('../utils/inventory/reconciliation');
const { getChannelInventoryView, listDriftSkus } = require('../utils/inventory/channelDrift');
const AmazonInventorySnapshot = require('../models/AmazonInventorySnapshot');
const { syncAmazonInventoryForClient } = require('../utils/inventory/amazonInventorySync');
const { auditLog } = require('../services/audit/auditWriter');
const {
  schedulePreNotice,
  shipNow,
  sendMigrationEmails,
} = require('../services/inventory/migrationRollout');

router.post('/:clientId/adjust', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const {
      sku,
      locationId = 'default',
      delta,
      newQty,
      reason = 'manual_recount',
      reasonNote = '',
      idempotencyKey,
    } = req.body || {};

    if (!sku) return res.status(400).json({ success: false, error: 'sku is required' });

    const product = await ShopifyProduct.findOne({
      clientId,
      $or: [{ sku }, { shopifyVariantId: sku }],
    }).lean();
    if (!product) return res.status(404).json({ success: false, error: 'SKU not found in catalog' });

    const resolvedSku = product.sku || sku;
    let signedDelta = Number(delta);
    if (newQty != null && !Number.isNaN(Number(newQty))) {
      signedDelta = Number(newQty) - (Number(product.inventoryQuantity) || 0);
    }
    if (!signedDelta || Number.isNaN(signedDelta)) {
      return res.status(400).json({ success: false, error: 'delta or newQty required' });
    }

    const key =
      idempotencyKey ||
      `manual:${clientId}:${resolvedSku}:${crypto.randomBytes(8).toString('hex')}`;

    const result = await applyAdjustment({
      clientId,
      sku: resolvedSku,
      locationId,
      delta: signedDelta,
      reason: INVENTORY_ADJUSTMENT_REASONS.includes(reason) ? reason : 'other',
      reasonNote,
      source: 'manual_dashboard',
      idempotencyKey: key,
      createdBy: {
        userId: req.user?._id?.toString() || req.user?.id || '',
        name: req.user?.name || req.user?.email || 'Dashboard user',
      },
      audit: { ip: req.ip || '', userAgent: req.get('user-agent') || '' },
    });

    res.json({
      success: true,
      duplicate: result.duplicate,
      adjustment: result.adjustment,
      newQty: result.adjustment?.qtyAfter ?? result.ledger?.available,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:clientId/adjustments', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { sku, reason, source, limit = 50, days = 90 } = req.query;
    const filter = { clientId };
    if (sku) filter.sku = sku;
    if (reason) filter.reason = reason;
    if (source) filter.source = source;
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - Math.min(Number(days) || 90, 365));
      filter.createdAt = { $gte: since };
    }

    const adjustments = await InventoryAdjustment.find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 500))
      .lean();

    res.json({ success: true, adjustments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:clientId/ledger/:sku', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId, sku } = req.params;
    const locationId = req.query.locationId || 'default';

    const [ledger, catalog, adjustments, mapping, velocity, channelView] = await Promise.all([
      InventoryLedger.findOne({ clientId, sku, locationId }).lean(),
      ShopifyProduct.findOne({ clientId, sku })
        .select('inventoryQuantity lastSyncedAt title imageUrl shopifyInventoryItemId shopifyProductId')
        .lean(),
      InventoryAdjustment.find({ clientId, sku }).sort({ createdAt: -1 }).limit(20).lean(),
      SkuMapping.findOne({ clientId, internalSku: sku }).lean(),
      buildSkuVelocity(clientId, sku),
      getChannelInventoryView(clientId, sku),
    ]);

    res.json({
      success: true,
      ledger: ledger || {
        available: catalog?.inventoryQuantity ?? 0,
        reserved: 0,
        onOrder: 0,
      },
      catalog,
      mapping,
      velocity,
      adjustments,
      channelView,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:clientId/sku-mappings', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const filter = req.query.filter || 'all';
    const q = { clientId };
    if (filter === 'low_confidence') q.confidence = { $lt: 80 };
    if (filter === 'manual') q.mappingSource = 'manual';
    if (filter === 'auto') q.mappingSource = 'auto';

    let mappings = await SkuMapping.find(q).sort({ updatedAt: -1 }).limit(500).lean();
    const stats = await mappingStats(clientId);

    if (filter === 'unmapped') {
      const unmapped = await listUnmappedSkus(clientId);
      return res.json({ success: true, mappings: [], unmapped, stats });
    }

    res.json({ success: true, mappings, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:clientId/sku-mappings/suggestions', protect, verifyClientAccess, async (req, res) => {
  const { amazonSellerSku } = req.query;
  if (!amazonSellerSku) {
    return res.status(400).json({ success: false, error: 'amazonSellerSku required' });
  }
  const suggestions = await suggestMappings(req.params.clientId, amazonSellerSku);
  res.json({ success: true, suggestions });
});

router.post('/:clientId/amazon-refresh', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { sellerSku } = req.body || {};
    const result = await syncAmazonInventoryForClient(clientId, {
      sellerSku: sellerSku || undefined,
      lastSyncSource: 'manual_refresh',
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:clientId/amazon-snapshots', protect, verifyClientAccess, async (req, res) => {
  const snapshots = await AmazonInventorySnapshot.find({ clientId: req.params.clientId })
    .sort({ lastSyncedAt: -1 })
    .limit(500)
    .lean();
  res.json({ success: true, snapshots });
});

router.get('/:clientId/drift', protect, verifyClientAccess, async (req, res) => {
  const drifts = await listDriftSkus(req.params.clientId, { limit: Number(req.query.limit) || 50 });
  res.json({ success: true, drifts, count: drifts.length });
});

router.get('/:clientId/inventory-config', protect, verifyClientAccess, async (req, res) => {
  const client = await Client.findOne({ clientId: req.params.clientId })
    .select('inventoryConfig amazonConfig.lastInventoryPullAt')
    .lean();
  res.json({
    success: true,
    inventoryConfig: client?.inventoryConfig || { defaultTruthSource: 'ledger' },
    lastAmazonInventoryPullAt: client?.amazonConfig?.lastInventoryPullAt,
  });
});

router.patch('/:clientId/inventory-config', protect, verifyClientAccess, authorize('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  const { defaultTruthSource, amazonInventoryPullHours } = req.body || {};
  const $set = {};
  if (defaultTruthSource) $set['inventoryConfig.defaultTruthSource'] = defaultTruthSource;
  if (amazonInventoryPullHours) $set['inventoryConfig.amazonInventoryPullHours'] = amazonInventoryPullHours;
  await Client.updateOne({ clientId: req.params.clientId }, { $set });
  res.json({ success: true });
});

router.patch('/:clientId/sku-mappings/:internalSku/truth-source', protect, verifyClientAccess, async (req, res) => {
  const { clientId, internalSku } = req.params;
  const { truthSource } = req.body || {};
  const allowed = ['ledger', 'shopify', 'amazon_fba', 'amazon_combined'];
  if (!allowed.includes(truthSource)) {
    return res.status(400).json({ success: false, error: 'invalid truthSource' });
  }
  const prev = await SkuMapping.findOne({ clientId, internalSku }).lean();
  await SkuMapping.updateOne({ clientId, internalSku }, { $set: { truthSource } });
  auditLog({
    category: 'inventory',
    action: 'inventory.truth_source_changed',
    clientId,
    details: { internalSku, from: prev?.truthSource, to: truthSource },
    actor: { type: 'user', userId: req.user?._id?.toString(), name: req.user?.name },
  }).catch(() => {});
  res.json({ success: true, truthSource });
});

router.post('/:clientId/sku-mappings', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { internalSku, shopify, amazon, mappingSource = 'manual', applyRetroactive = true, truthSource } =
      req.body || {};
    if (!internalSku) return res.status(400).json({ success: false, error: 'internalSku required' });

    const client = await Client.findOne({ clientId }).select('inventoryConfig').lean();
    const resolvedTruth = truthSource || client?.inventoryConfig?.defaultTruthSource || 'ledger';

    const mapping = await SkuMapping.findOneAndUpdate(
      { clientId, internalSku },
      {
        $set: {
          shopify: shopify || null,
          amazon: amazon || null,
          mappingSource,
          truthSource: resolvedTruth,
          confidence: 100,
          verifiedBy: { userId: req.user?._id?.toString() || '', at: new Date() },
        },
      },
      { upsert: true, new: true }
    );

    let retro = { applied: 0 };
    if (applyRetroactive && amazon?.sellerSku) {
      retro = await applyRetroactiveAmazonOrders(clientId, internalSku, amazon.sellerSku);
    }

    res.json({ success: true, mapping, retroactive: retro });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/:clientId/sku-mappings/csv', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ success: false, error: 'rows array required' });
    }

    let upserted = 0;
    for (const row of rows) {
      const internalSku = row.internal_sku || row.internalSku;
      if (!internalSku) continue;
      await SkuMapping.findOneAndUpdate(
        { clientId, internalSku },
        {
          $set: {
            shopify: row.shopify_sku
              ? { sku: row.shopify_sku, locationIds: ['default'] }
              : row.shopify || null,
            amazon: row.amazon_sku
              ? { sellerSku: row.amazon_sku, fulfillment: 'merchant' }
              : row.amazon || null,
            mappingSource: 'csv_import',
            confidence: 100,
          },
        },
        { upsert: true }
      );
      upserted += 1;
    }

    res.json({ success: true, upserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/:clientId/sku-mappings/:internalSku', protect, verifyClientAccess, async (req, res) => {
  await SkuMapping.deleteOne({ clientId: req.params.clientId, internalSku: req.params.internalSku });
  res.json({ success: true });
});

router.post('/:clientId/reconcile', protect, verifyClientAccess, async (req, res) => {
  try {
    const result = await reconcileClientInventory(req.params.clientId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:clientId/reports/adjustments', protect, verifyClientAccess, async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const rows = await InventoryAdjustment.find({
    clientId: req.params.clientId,
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ success: true, rows, days });
});

router.get('/:clientId/reports/channel-performance', protect, verifyClientAccess, async (req, res) => {
  const days = Math.min(Number(req.query.days) || 30, 90);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const orders = await Order.find({ clientId: req.params.clientId, createdAt: { $gte: since } })
    .select('source items totalPrice')
    .lean();

  const bySku = {};
  for (const o of orders) {
    const ch = o.source === 'amazon' ? 'amazon' : 'shopify';
    for (const item of o.items || []) {
      const sku = item.sku || item.name || 'unknown';
      if (!bySku[sku]) bySku[sku] = { sku, shopifyUnits: 0, amazonUnits: 0, shopifyRevenue: 0, amazonRevenue: 0 };
      const q = Number(item.quantity) || 1;
      const rev = Number(item.price) * q || 0;
      if (ch === 'amazon') {
        bySku[sku].amazonUnits += q;
        bySku[sku].amazonRevenue += rev;
      } else {
        bySku[sku].shopifyUnits += q;
        bySku[sku].shopifyRevenue += rev;
      }
    }
  }

  res.json({ success: true, skus: Object.values(bySku), days });
});

router.get('/:clientId/reports/stockouts', protect, verifyClientAccess, async (req, res) => {
  const days = Math.min(Number(req.query.days) || 90, 180);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const events = await InventoryAdjustment.find({
    clientId: req.params.clientId,
    qtyAfter: 0,
    qtyBefore: { $gt: 0 },
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .select('sku createdAt source reason qtyBefore qtyAfter')
    .lean();
  res.json({ success: true, events, days });
});

router.post('/:clientId/seed-ledger', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const products = await ShopifyProduct.find({ clientId, sku: { $ne: '' } })
      .select('sku inventoryQuantity')
      .lean();
    let upserted = 0;
    for (const p of products) {
      const qty = Number(p.inventoryQuantity) || 0;
      await InventoryLedger.findOneAndUpdate(
        { clientId, sku: p.sku, locationId: 'default' },
        {
          $setOnInsert: { reserved: 0, onOrder: 0 },
          $set: { available: qty, lastShopifySync: { at: new Date(), qty } },
        },
        { upsert: true }
      );
      upserted += 1;
    }
    res.json({ success: true, upserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/:clientId/migration-notice', protect, verifyClientAccess, async (req, res) => {
  const client = await Client.findOne({ clientId: req.params.clientId })
    .select('inventoryTruthPreNoticeAt inventoryTruthShippedAt inventoryTruthEmailSentAt')
    .lean();
  const now = Date.now();
  const shipped = client?.inventoryTruthShippedAt
    ? new Date(client.inventoryTruthShippedAt).getTime()
    : now;
  const preNotice = client?.inventoryTruthPreNoticeAt
    ? new Date(client.inventoryTruthPreNoticeAt).getTime()
    : shipped - 7 * 24 * 60 * 60 * 1000;

  res.json({
    success: true,
    showPreDeploymentBanner: now >= preNotice && now < shipped,
    showDayOfModal: !!client?.inventoryTruthShippedAt,
    shippedAt: client?.inventoryTruthShippedAt,
    emailSentAt: client?.inventoryTruthEmailSentAt,
  });
});

router.post('/:clientId/migration/schedule', protect, verifyClientAccess, authorize('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  const out = await schedulePreNotice(req.params.clientId, { daysBefore: req.body?.daysBefore || 7 });
  res.json({ success: true, ...out });
});

router.post('/:clientId/migration/ship', protect, verifyClientAccess, authorize('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  const out = await shipNow(req.params.clientId);
  res.json({ success: true, ...out });
});

router.post('/:clientId/migration/email', protect, verifyClientAccess, authorize('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  const out = await sendMigrationEmails(req.params.clientId);
  res.json({ success: true, ...out });
});

router.post('/:clientId/migration-notice/dismiss', protect, verifyClientAccess, async (req, res) => {
  res.json({ success: true });
});

async function mappingStats(clientId) {
  const mappings = await SkuMapping.find({ clientId }).lean();
  let fullyMapped = 0;
  let shopifyOnly = 0;
  let amazonOnly = 0;
  for (const m of mappings) {
    const hasS = !!(m.shopify?.sku || m.shopify?.variantId);
    const hasA = !!m.amazon?.sellerSku;
    if (hasS && hasA) fullyMapped += 1;
    else if (hasS) shopifyOnly += 1;
    else if (hasA) amazonOnly += 1;
  }
  const unmapped = await listUnmappedSkus(clientId);
  return {
    totalInternal: mappings.length,
    fullyMapped,
    shopifyOnly,
    amazonOnly,
    unmappedShopifyCount: unmapped.unmappedShopifyCount,
  };
}

async function buildSkuVelocity(clientId, sku) {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const orders = await Order.find({ clientId, createdAt: { $gte: since } }).select('source items').lean();
  let shopifyUnits = 0;
  let amazonUnits = 0;
  for (const o of orders) {
    for (const item of o.items || []) {
      if (item.sku !== sku) continue;
      const q = Number(item.quantity) || 1;
      if (o.source === 'amazon') amazonUnits += q;
      else shopifyUnits += q;
    }
  }
  return { shopifyUnits30d: shopifyUnits, amazonUnits30d: amazonUnits, total: shopifyUnits + amazonUnits };
}

// Phase 3+4 routes (single mount — avoids Express missing stacked routers on old deploys)
router.use(require('./inventoryExtended'));

module.exports = router;
