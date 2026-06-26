'use strict';

const OptInTool = require('../models/OptInTool');
const { withShopifyRetry } = require('../utils/shopify/shopifyHelper');

const POOL_TARGET = 50;
const POOL_REPLENISH_THRESHOLD = 10;

function shortToolId(toolId) {
  return String(toolId || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() || 'TOOL';
}

function generateUniqueCode(toolId) {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `TOPEDGE-${shortToolId(toolId)}-${rand}`;
}

async function createShopifyDiscount(clientId, { code, discountType, discountValue, minimumOrderAmount, usageLimit = 1 }) {
  return withShopifyRetry(clientId, async (shop) => {
    const now = new Date();
    const endsAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const isPercent = discountType !== 'fixed_amount';
    const priceRule = {
      title: `TopEdge Opt-in ${code}`,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: isPercent ? 'percentage' : 'fixed_amount',
      value: isPercent ? `-${Number(discountValue) || 10}.0` : `-${Number(discountValue) || 100}.0`,
      customer_selection: 'all',
      starts_at: now.toISOString(),
      ends_at: endsAt.toISOString(),
      usage_limit: usageLimit,
    };
    if (minimumOrderAmount > 0) {
      priceRule.prerequisite_subtotal_range = {
        greater_than_or_equal_to: String(minimumOrderAmount),
      };
    }
    const priceRuleRes = await shop.post('/price_rules.json', { price_rule: priceRule });
    const priceRuleId = priceRuleRes.data.price_rule.id;
    await shop.post(`/price_rules/${priceRuleId}/discount_codes.json`, {
      discount_code: { code },
    });
    return { code, priceRuleId: String(priceRuleId) };
  });
}

async function replenishCouponPool(clientId, toolId) {
  const tool = await OptInTool.findOne({ _id: toolId, clientId });
  if (!tool) return { added: 0 };
  const discount = tool.design?.discount || {};
  if (discount.mode !== 'auto_shopify') return { added: 0 };

  const pool = Array.isArray(tool.couponPool) ? tool.couponPool : [];
  const available = pool.filter((p) => !p.used).length;
  if (available >= POOL_REPLENISH_THRESHOLD) return { added: 0, available };

  const toCreate = Math.min(POOL_TARGET - available, 20);
  const created = [];
  for (let i = 0; i < toCreate; i++) {
    const code = generateUniqueCode(toolId);
    try {
      const result = await createShopifyDiscount(clientId, {
        code,
        discountType: discount.discountType || 'percentage',
        discountValue: discount.discountValue ?? 10,
        minimumOrderAmount: discount.minimumOrderAmount ?? 0,
        usageLimit: 1,
      });
      created.push({
        code: result.code,
        priceRuleId: result.priceRuleId,
        used: false,
        createdAt: new Date(),
      });
    } catch (e) {
      console.warn('[optInCoupon] pool create failed', e.message);
      break;
    }
  }
  if (created.length) {
    tool.couponPool = [...pool, ...created];
    await tool.save();
  }
  return { added: created.length, available: available + created.length };
}

async function claimCoupon(clientId, tool) {
  const discount = tool.design?.discount || {};
  if (discount.mode === 'manual' && discount.manualCode) {
    return { code: String(discount.manualCode).trim(), source: 'manual' };
  }
  if (discount.mode !== 'auto_shopify') {
    return { code: discount.manualCode || '', source: 'none' };
  }

  const pool = Array.isArray(tool.couponPool) ? tool.couponPool : [];
  const entry = pool.find((p) => !p.used);
  if (entry) {
    entry.used = true;
    entry.usedAt = new Date();
    await OptInTool.updateOne({ _id: tool._id, clientId }, { $set: { couponPool: pool } });
    replenishCouponPool(clientId, tool._id).catch(() => {});
    return { code: entry.code, source: 'pool', priceRuleId: entry.priceRuleId };
  }

  const code = generateUniqueCode(tool._id);
  const result = await createShopifyDiscount(clientId, {
    code,
    discountType: discount.discountType || 'percentage',
    discountValue: discount.discountValue ?? 10,
    minimumOrderAmount: discount.minimumOrderAmount ?? 0,
    usageLimit: 1,
  });
  return { code: result.code, source: 'on_demand', priceRuleId: result.priceRuleId };
}

module.exports = {
  generateUniqueCode,
  createShopifyDiscount,
  replenishCouponPool,
  claimCoupon,
  POOL_TARGET,
  POOL_REPLENISH_THRESHOLD,
};
