'use strict';

const Order = require('../../models/Order');
const InventoryLedger = require('../../models/InventoryLedger');
const Supplier = require('../../models/Supplier');
const PurchaseOrder = require('../../models/PurchaseOrder');
const ShopifyProduct = require('../../models/ShopifyProduct');
const RestockSuggestionDismissal = require('../../models/RestockSuggestionDismissal');
const { buildSkuForecast } = require('./forecastModel');
const {
  resolveRuleForSku,
  computeReorderQty,
  computeUrgency,
  hasOpenPoForSku,
} = require('./restockRules');

async function nextPoNumber(clientId) {
  const year = new Date().getFullYear();
  const count = await PurchaseOrder.countDocuments({
    clientId,
    poNumber: new RegExp(`^PO-${year}-`),
  });
  return `PO-${year}-${String(count + 1).padStart(3, '0')}`;
}

async function generateRestockSuggestions(clientId) {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const orders = await Order.find({ clientId, createdAt: { $gte: since } })
    .select('source items createdAt totalPrice')
    .lean();

  const skusSold = new Set();
  for (const o of orders) {
    for (const item of o.items || []) {
      if (item.sku) skusSold.add(item.sku);
    }
  }

  const dismissals = await RestockSuggestionDismissal.find({
    clientId,
    snoozedUntil: { $gt: new Date() },
  }).lean();
  const snoozed = new Set(dismissals.map((d) => d.sku));

  const suggestions = [];

  for (const sku of skusSold) {
    if (snoozed.has(sku)) continue;

    const forecast = buildSkuForecast(orders, sku, 0);
    if (forecast.velocity <= 0) continue;

    const ledger = await InventoryLedger.findOne({ clientId, sku, locationId: 'default' }).lean();
    const catalog = await ShopifyProduct.findOne({ clientId, sku }).select('title inventoryQuantity price').lean();
    const stock = ledger ? Number(ledger.available) : Number(catalog?.inventoryQuantity) || 0;
    const onOrder = ledger ? Number(ledger.onOrder) || 0 : 0;

    const rule = await resolveRuleForSku(clientId, sku);
    const { urgency, reorderPoint } = computeUrgency(stock, onOrder, forecast.velocity, rule);
    if (urgency === 'healthy' || urgency === 'idle') continue;

    const openPo = await hasOpenPoForSku(clientId, sku);
    if (openPo) continue;

    const suggestedQuantity = computeReorderQty(rule, forecast.velocity, reorderPoint);
    let preferredSupplier = null;
    if (rule.preferredSupplierId) {
      preferredSupplier = await Supplier.findById(rule.preferredSupplierId).lean();
    }
    if (!preferredSupplier) {
      preferredSupplier = await Supplier.findOne({ clientId, isPreferred: true }).lean();
    }
    if (!preferredSupplier) {
      preferredSupplier = await Supplier.findOne({ clientId }).lean();
    }

    const leadTimeDays = Number(rule.leadTimeDays) || 14;
    const depletion = stock / Math.max(0.01, forecast.velocity);
    const daysWithoutStock = Math.max(0, leadTimeDays - depletion);
    const aov =
      orders.length > 0
        ? orders.reduce((a, o) => a + (Number(o.totalPrice) || 0), 0) /
          Math.max(1, orders.length)
        : Number(catalog?.price) || 0;
    const estimatedRevenueLoss = daysWithoutStock * forecast.velocity * aov;

    suggestions.push({
      sku,
      productName: catalog?.title || sku,
      currentStock: stock,
      onOrder,
      reorderPoint,
      suggestedQuantity,
      leadTimeDays,
      preferredSupplier: preferredSupplier
        ? { id: preferredSupplier._id, name: preferredSupplier.name, phone: preferredSupplier.phone }
        : null,
      urgency: urgency === 'urgent' ? 'critical' : urgency === 'low' ? 'high' : 'medium',
      reason: `Stock ${stock} vs reorder point ${reorderPoint}. Velocity ${forecast.velocity.toFixed(2)}/day.`,
      estimatedRevenueLoss: Math.round(estimatedRevenueLoss),
      confidence: forecast.confidence,
      trend: forecast.trend,
      depletion: forecast.depletion,
    });
  }

  suggestions.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.urgency] ?? 9) - (order[b.urgency] ?? 9);
  });

  return suggestions;
}

async function createDraftPoFromSuggestion(clientId, suggestion, { generatedBy = 'smart_suggestion' } = {}) {
  if (!suggestion.preferredSupplier?.id) {
    throw new Error('no_supplier');
  }
  const poNumber = await nextPoNumber(clientId);
  const unitCost =
    (await Supplier.findById(suggestion.preferredSupplier.id).lean())?.products?.find(
      (p) => p.productId === suggestion.sku || p.supplierSKU === suggestion.sku
    )?.unitCost || 0;

  const line = {
    sku: suggestion.sku,
    productName: suggestion.productName,
    quantity: suggestion.suggestedQuantity,
    unitCost,
    currency: 'INR',
  };
  const subtotal = line.quantity * line.unitCost;

  const po = await PurchaseOrder.create({
    clientId,
    poNumber,
    supplierId: suggestion.preferredSupplier.id,
    status: 'draft',
    lineItems: [line],
    items: [line],
    subtotal,
    total: subtotal,
    totalCost: subtotal,
    currency: 'INR',
    generatedBy,
    events: [{ type: 'created', notes: suggestion.reason }],
  });

  return po;
}

module.exports = {
  generateRestockSuggestions,
  createDraftPoFromSuggestion,
  nextPoNumber,
};
