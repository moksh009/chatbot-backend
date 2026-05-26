'use strict';

const express = require('express');
const router = express.Router();
const { protect, verifyClientAccess, authorize } = require('../middleware/auth');
const RestockRule = require('../models/RestockRule');
const PurchaseOrder = require('../models/PurchaseOrder');
const StockoutEvent = require('../models/StockoutEvent');
const ReturnEvent = require('../models/ReturnEvent');
const InventoryLocation = require('../models/InventoryLocation');
const BundleDefinition = require('../models/BundleDefinition');
const BackorderRule = require('../models/BackorderRule');
const RestockSuggestionDismissal = require('../models/RestockSuggestionDismissal');
const Order = require('../models/Order');
const Client = require('../models/Client');
const { seedDefaultRestockRules, resolveRuleForSku } = require('../utils/inventory/restockRules');
const {
  generateRestockSuggestions,
  createDraftPoFromSuggestion,
} = require('../utils/inventory/restockSuggestionEngine');
const { createPurchaseOrder, receivePurchaseOrder } = require('../utils/inventory/purchaseOrderService');
const { inspectReturn } = require('../utils/inventory/returnHandler');
const { ensureDefaultLocation, transferStock } = require('../utils/inventory/locationLedger');
const { getBundleAvailability } = require('../utils/inventory/bundleHandler');
const { enrichStockoutEstimates } = require('../utils/inventory/stockoutTracker');
const { MeeshoAdapter } = require('../utils/inventory/meeshoAdapter');
const { FlipkartAdapter } = require('../utils/inventory/flipkartAdapter');
const { buildSkuForecast } = require('../utils/inventory/forecastModel');
const AmazonInventorySnapshot = require('../models/AmazonInventorySnapshot');
const SkuMapping = require('../models/SkuMapping');
const InventoryLedger = require('../models/InventoryLedger');

// ─── Restock rules ───────────────────────────────────────────────
router.get('/:clientId/restock-rules', protect, verifyClientAccess, async (req, res) => {
  await seedDefaultRestockRules(req.params.clientId);
  const rules = await RestockRule.find({ clientId: req.params.clientId }).lean();
  res.json({ success: true, rules });
});

router.put('/:clientId/restock-rules', protect, verifyClientAccess, async (req, res) => {
  const { clientId } = req.params;
  const body = req.body || {};
  const filter = body.sku ? { clientId, sku: body.sku } : { clientId, category: body.category || 'default', sku: null };
  const rule = await RestockRule.findOneAndUpdate(filter, { $set: { clientId, ...body } }, { upsert: true, new: true });
  res.json({ success: true, rule });
});

router.get('/:clientId/restock-rules/:sku', protect, verifyClientAccess, async (req, res) => {
  const rule = await resolveRuleForSku(req.params.clientId, req.params.sku);
  res.json({ success: true, rule });
});

// ─── Suggestions ─────────────────────────────────────────────────
router.get('/:clientId/restock-suggestions', protect, verifyClientAccess, async (req, res) => {
  const suggestions = await generateRestockSuggestions(req.params.clientId);
  res.json({ success: true, suggestions });
});

router.post('/:clientId/restock-suggestions/dismiss', protect, verifyClientAccess, async (req, res) => {
  const { sku, hours = 24, reason = '' } = req.body || {};
  const until = new Date();
  until.setHours(until.getHours() + Number(hours));
  await RestockSuggestionDismissal.findOneAndUpdate(
    { clientId: req.params.clientId, sku },
    { $set: { snoozedUntil: until, reason } },
    { upsert: true }
  );
  res.json({ success: true, snoozedUntil: until });
});

router.post('/:clientId/restock-suggestions/create-po', protect, verifyClientAccess, async (req, res) => {
  const { skus = [] } = req.body || {};
  const all = await generateRestockSuggestions(req.params.clientId);
  const selected = all.filter((s) => skus.includes(s.sku));
  const bySupplier = {};
  for (const s of selected) {
    const sid = s.preferredSupplier?.id?.toString() || 'none';
    if (!bySupplier[sid]) bySupplier[sid] = [];
    bySupplier[sid].push(s);
  }
  const pos = [];
  for (const group of Object.values(bySupplier)) {
    if (!group[0]?.preferredSupplier?.id) continue;
    const lines = group.map((g) => ({
      sku: g.sku,
      productName: g.productName,
      quantity: g.suggestedQuantity,
      unitCost: 0,
    }));
    const po = await createPurchaseOrder(req.params.clientId, {
      supplierId: group[0].preferredSupplier.id,
      lineItems: lines,
      generatedBy: 'smart_suggestion',
      status: 'draft',
    });
    pos.push(po);
  }
  res.json({ success: true, purchaseOrders: pos });
});

router.post('/:clientId/restock-suggestions/:sku/draft-po', protect, verifyClientAccess, async (req, res) => {
  const suggestions = await generateRestockSuggestions(req.params.clientId);
  const s = suggestions.find((x) => x.sku === req.params.sku);
  if (!s) return res.status(404).json({ success: false, error: 'suggestion_not_found' });
  const po = await createDraftPoFromSuggestion(req.params.clientId, s);
  res.json({ success: true, purchaseOrder: po });
});

// ─── Purchase orders ─────────────────────────────────────────────
router.get('/:clientId/purchase-orders', protect, verifyClientAccess, async (req, res) => {
  const filter = { clientId: req.params.clientId };
  if (req.query.status) filter.status = req.query.status;
  const orders = await PurchaseOrder.find(filter).sort({ createdAt: -1 }).limit(200).populate('supplierId').lean();
  const stats = {
    draft: await PurchaseOrder.countDocuments({ clientId: req.params.clientId, status: 'draft' }),
    sent: await PurchaseOrder.countDocuments({
      clientId: req.params.clientId,
      status: { $in: ['sent', 'confirmed'] },
    }),
    overdue: await PurchaseOrder.countDocuments({
      clientId: req.params.clientId,
      status: { $in: ['sent', 'confirmed'] },
      expectedDeliveryDate: { $lt: new Date() },
    }),
  };
  res.json({ success: true, orders, stats });
});

router.post('/:clientId/purchase-orders', protect, verifyClientAccess, async (req, res) => {
  const po = await createPurchaseOrder(req.params.clientId, req.body || {});
  res.json({ success: true, purchaseOrder: po });
});

router.patch('/:clientId/purchase-orders/:poId', protect, verifyClientAccess, async (req, res) => {
  const po = await PurchaseOrder.findOneAndUpdate(
    { clientId: req.params.clientId, _id: req.params.poId },
    { $set: req.body },
    { new: true }
  );
  res.json({ success: true, purchaseOrder: po });
});

router.post('/:clientId/purchase-orders/:poId/receive', protect, verifyClientAccess, async (req, res) => {
  const po = await receivePurchaseOrder(
    req.params.clientId,
    req.params.poId,
    req.body?.lineReceipts || [],
    { userId: req.user?._id?.toString(), name: req.user?.name }
  );
  res.json({ success: true, purchaseOrder: po });
});

router.post('/:clientId/purchase-orders/:poId/send', protect, verifyClientAccess, async (req, res) => {
  const po = await PurchaseOrder.findOne({ clientId: req.params.clientId, _id: req.params.poId });
  if (!po) return res.status(404).json({ success: false, error: 'not_found' });
  po.status = 'sent';
  po.sentAt = new Date();
  po.events.push({
    at: new Date(),
    type: 'sent',
    channel: req.body?.channel || 'manual',
    notes: req.body?.notes || '',
    actor: { userId: req.user?._id?.toString(), name: req.user?.name },
  });
  await po.save();
  res.json({ success: true, purchaseOrder: po });
});

// ─── Stockout events ─────────────────────────────────────────────
router.get('/:clientId/reports/stockout-impact', protect, verifyClientAccess, async (req, res) => {
  const days = Math.min(Number(req.query.days) || 90, 180);
  const since = new Date();
  since.setDate(since.getDate() - days);
  const events = await StockoutEvent.find({
    clientId: req.params.clientId,
    startedAt: { $gte: since },
  })
    .sort({ startedAt: -1 })
    .lean();
  const orders = await Order.find({ clientId: req.params.clientId, createdAt: { $gte: since } })
    .select('items totalPrice')
    .lean();
  const enriched = await enrichStockoutEstimates(req.params.clientId, events, orders);
  const totalDuration = enriched.reduce((a, e) => a + (e.durationHours || 0), 0);
  const totalLost = enriched.reduce((a, e) => a + (e.estimatedLostSales || 0), 0);
  res.json({
    success: true,
    events: enriched,
    summary: { totalEvents: enriched.length, totalDurationHours: totalDuration, estimatedLostSales: totalLost },
    days,
  });
});

// ─── Returns ─────────────────────────────────────────────────────
router.get('/:clientId/returns', protect, verifyClientAccess, async (req, res) => {
  const filter = { clientId: req.params.clientId };
  if (req.query.status) filter.status = req.query.status;
  const returns = await ReturnEvent.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  res.json({ success: true, returns });
});

router.post('/:clientId/returns', protect, verifyClientAccess, async (req, res) => {
  const doc = await ReturnEvent.create({
    clientId: req.params.clientId,
    ...req.body,
    events: [{ type: 'created', actor: { userId: req.user?._id?.toString(), name: req.user?.name } }],
  });
  res.json({ success: true, return: doc });
});

router.post('/:clientId/returns/:returnId/inspect', protect, verifyClientAccess, async (req, res) => {
  const doc = await inspectReturn(req.params.clientId, req.params.returnId, req.body?.lineUpdates || [], {
    userId: req.user?._id?.toString(),
    name: req.user?.name,
  });
  res.json({ success: true, return: doc });
});

// ─── Locations ───────────────────────────────────────────────────
router.get('/:clientId/locations', protect, verifyClientAccess, async (req, res) => {
  await ensureDefaultLocation(req.params.clientId);
  const locations = await InventoryLocation.find({ clientId: req.params.clientId }).lean();
  res.json({ success: true, locations });
});

router.post('/:clientId/locations', protect, verifyClientAccess, async (req, res) => {
  const { locationId, name, type, shopifyLocationId, isDefault } = req.body || {};
  if (isDefault) {
    await InventoryLocation.updateMany({ clientId: req.params.clientId }, { $set: { isDefault: false } });
  }
  const loc = await InventoryLocation.findOneAndUpdate(
    { clientId: req.params.clientId, locationId },
    { $set: { clientId: req.params.clientId, locationId, name, type, shopifyLocationId, isDefault: !!isDefault, isActive: true } },
    { upsert: true, new: true }
  );
  res.json({ success: true, location: loc });
});

router.post('/:clientId/transfer', protect, verifyClientAccess, async (req, res) => {
  const { sku, fromLocation, toLocation, qty, idempotencyKey } = req.body || {};
  const map = await transferStock({
    clientId: req.params.clientId,
    sku,
    fromLocation,
    toLocation,
    qty,
    idempotencyKey,
    createdBy: { userId: req.user?._id?.toString(), name: req.user?.name },
  });
  res.json({ success: true, byLocation: map });
});

// ─── Bundles ─────────────────────────────────────────────────────
router.get('/:clientId/bundles', protect, verifyClientAccess, async (req, res) => {
  const bundles = await BundleDefinition.find({ clientId: req.params.clientId }).lean();
  const withAvail = [];
  for (const b of bundles) {
    const avail = await getBundleAvailability(req.params.clientId, b.bundleSku);
    withAvail.push({ ...b, availability: avail });
  }
  res.json({ success: true, bundles: withAvail });
});

router.put('/:clientId/bundles/:bundleSku', protect, verifyClientAccess, async (req, res) => {
  const bundle = await BundleDefinition.findOneAndUpdate(
    { clientId: req.params.clientId, bundleSku: req.params.bundleSku },
    { $set: { clientId: req.params.clientId, bundleSku: req.params.bundleSku, ...req.body } },
    { upsert: true, new: true }
  );
  res.json({ success: true, bundle });
});

router.delete('/:clientId/bundles/:bundleSku', protect, verifyClientAccess, async (req, res) => {
  await BundleDefinition.deleteOne({ clientId: req.params.clientId, bundleSku: req.params.bundleSku });
  res.json({ success: true });
});

// ─── Backorders ──────────────────────────────────────────────────
router.get('/:clientId/backorders', protect, verifyClientAccess, async (req, res) => {
  const rows = await InventoryLedger.find({ clientId: req.params.clientId, backorder: { $gt: 0 } }).lean();
  res.json({ success: true, backorders: rows });
});

router.put('/:clientId/backorders/:sku', protect, verifyClientAccess, async (req, res) => {
  const rule = await BackorderRule.findOneAndUpdate(
    { clientId: req.params.clientId, sku: req.params.sku },
    { $set: { clientId: req.params.clientId, sku: req.params.sku, ...req.body } },
    { upsert: true, new: true }
  );
  res.json({ success: true, rule });
});

// ─── Channel integrations ──────────────────────────────────────────
router.get('/:clientId/channels/status', protect, verifyClientAccess, async (req, res) => {
  const client = await Client.findOne({ clientId: req.params.clientId })
    .select('meeshoConfig flipkartConfig amazonConfig')
    .lean();
  const meesho = new MeeshoAdapter(req.params.clientId, client?.meeshoConfig || {});
  const flipkart = new FlipkartAdapter(req.params.clientId, client?.flipkartConfig || {});
  const [m, f] = await Promise.all([meesho.verifyConnection(), flipkart.verifyConnection()]);
  res.json({
    success: true,
    meesho: { ...m, connected: m.ok },
    flipkart: { ...f, connected: f.ok },
    amazon: { connected: !!client?.amazonConfig?.refreshToken },
  });
});

router.patch('/:clientId/channels/:channel', protect, verifyClientAccess, authorize('CLIENT_ADMIN', 'SUPER_ADMIN'), async (req, res) => {
  const { channel } = req.params;
  const field = channel === 'meesho' ? 'meeshoConfig' : channel === 'flipkart' ? 'flipkartConfig' : null;
  if (!field) return res.status(400).json({ success: false, error: 'invalid_channel' });
  await Client.updateOne({ clientId: req.params.clientId }, { $set: { [field]: req.body } });
  res.json({ success: true });
});

// ─── Channel qty batch for list UI ───────────────────────────────
router.get('/:clientId/channel-qty', protect, verifyClientAccess, async (req, res) => {
  const skus = String(req.query.skus || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  const clientId = req.params.clientId;
  const [ledgers, mappings, snapshots] = await Promise.all([
    InventoryLedger.find({ clientId, sku: { $in: skus }, locationId: 'default' }).lean(),
    SkuMapping.find({ clientId, internalSku: { $in: skus } }).lean(),
    AmazonInventorySnapshot.find({ clientId }).lean(),
  ]);
  const ledgerMap = Object.fromEntries(ledgers.map((l) => [l.sku, l.available]));
  const mappingMap = Object.fromEntries(mappings.map((m) => [m.internalSku, m]));
  const snapBySeller = Object.fromEntries(snapshots.map((s) => [s.sellerSku, s]));

  const rows = skus.map((sku) => {
    const m = mappingMap[sku];
    const snap = m?.amazon?.sellerSku ? snapBySeller[m.amazon.sellerSku] : null;
    return {
      sku,
      ledger: ledgerMap[sku] ?? null,
      shopify: ledgerMap[sku],
      amazonFba: snap?.fba?.fulfillable ?? null,
      amazonMf: snap?.merchantFulfilled?.quantity ?? null,
      amazonTotal: snap?.totalSellable ?? null,
      amazonSyncedAt: snap?.lastSyncedAt ?? null,
    };
  });
  res.json({ success: true, rows });
});

// ─── SKU forecast detail ─────────────────────────────────────────
router.get('/:clientId/forecast/:sku', protect, verifyClientAccess, async (req, res) => {
  const since = new Date();
  since.setDate(since.getDate() - 90);
  const orders = await Order.find({ clientId: req.params.clientId, createdAt: { $gte: since } })
    .select('source items createdAt totalPrice')
    .lean();
  const ledger = await InventoryLedger.findOne({
    clientId: req.params.clientId,
    sku: req.params.sku,
    locationId: 'default',
  }).lean();
  const stock = ledger ? Number(ledger.available) : 0;
  const forecast = buildSkuForecast(orders, req.params.sku, stock);
  res.json({ success: true, forecast, stock });
});

module.exports = router;
