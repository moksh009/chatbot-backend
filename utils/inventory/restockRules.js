'use strict';

const RestockRule = require('../../models/RestockRule');
const PurchaseOrder = require('../../models/PurchaseOrder');

const CATEGORY_DEFAULTS = {
  default: { leadTimeDays: 14, safetyStockDays: 7, criticalDays: 3, lowDays: 7 },
  fashion: { leadTimeDays: 30, safetyStockDays: 14, criticalDays: 5, lowDays: 10 },
  electronics: { leadTimeDays: 21, safetyStockDays: 10, criticalDays: 4, lowDays: 8 },
  consumables: { leadTimeDays: 7, safetyStockDays: 3, criticalDays: 2, lowDays: 5 },
};

async function seedDefaultRestockRules(clientId) {
  const existing = await RestockRule.countDocuments({ clientId, sku: null, category: 'default' });
  if (existing) return { seeded: 0 };
  const defs = CATEGORY_DEFAULTS;
  let seeded = 0;
  for (const [category, rule] of Object.entries(defs)) {
    await RestockRule.findOneAndUpdate(
      { clientId, category, sku: null },
      { $set: { clientId, category, sku: null, ...rule } },
      { upsert: true }
    );
    seeded += 1;
  }
  return { seeded };
}

async function resolveRuleForSku(clientId, sku, category = 'default') {
  const skuRule = await RestockRule.findOne({ clientId, sku }).lean();
  if (skuRule) return skuRule;
  const catRule = await RestockRule.findOne({ clientId, category, sku: null }).lean();
  if (catRule) return catRule;
  const def = await RestockRule.findOne({ clientId, category: 'default', sku: null }).lean();
  return def || { ...CATEGORY_DEFAULTS.default, clientId };
}

function computeReorderPoint(rule, velocity) {
  const v = Math.max(0.01, Number(velocity) || 0);
  const lead = Number(rule.leadTimeDays) || 14;
  const safety = Number(rule.safetyStockDays) || 7;
  return Math.ceil((lead + safety) * v);
}

function computeReorderQty(rule, velocity, reorderPoint) {
  const moq = Number(rule.minOrderQuantity) || 1;
  if (rule.reorderQuantity != null) return Math.max(moq, Number(rule.reorderQuantity));
  const lead = Number(rule.leadTimeDays) || 14;
  const v = Math.max(0.01, Number(velocity) || 0);
  return Math.max(moq, Math.ceil(lead * v * 2));
}

function computeUrgency(currentStock, reservedInbound, velocity, rule) {
  const stock = Number(currentStock) || 0;
  const inbound = Number(reservedInbound) || 0;
  const effective = stock + inbound;
  const v = Number(velocity) || 0;
  const criticalThreshold = (Number(rule.criticalDays) || 3) * v;
  const lowThreshold = (Number(rule.lowDays) || 7) * v;
  const reorderPoint = computeReorderPoint(rule, v);

  if (v <= 0) return { urgency: 'idle', reorderPoint, criticalThreshold, lowThreshold };
  if (effective <= criticalThreshold) return { urgency: 'urgent', reorderPoint, criticalThreshold, lowThreshold };
  if (effective <= lowThreshold || effective <= reorderPoint) {
    return { urgency: 'low', reorderPoint, criticalThreshold, lowThreshold };
  }
  return { urgency: 'healthy', reorderPoint, criticalThreshold, lowThreshold };
}

async function hasOpenPoForSku(clientId, sku) {
  const open = await PurchaseOrder.findOne({
    clientId,
    status: { $in: ['draft', 'pending_approval', 'sent', 'confirmed', 'partially_received'] },
    $or: [{ 'lineItems.sku': sku }, { 'items.sku': sku }],
  }).lean();
  return !!open;
}

module.exports = {
  CATEGORY_DEFAULTS,
  seedDefaultRestockRules,
  resolveRuleForSku,
  computeReorderPoint,
  computeReorderQty,
  computeUrgency,
  hasOpenPoForSku,
};
