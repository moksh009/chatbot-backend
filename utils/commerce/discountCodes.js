'use strict';

/**
 * Discount code helpers for Store Engine → Discounts tab.
 */

function resolveUsageLimit(mode, count) {
  if (mode === 'unlimited') return { usageLimit: null, usageLimitLabel: 'Unlimited' };
  if (mode === 'limited') {
    const n = Math.max(1, parseInt(count, 10) || 1);
    return { usageLimit: n, usageLimitLabel: `Up to ${n} uses` };
  }
  return { usageLimit: 1, usageLimitLabel: 'Single use' };
}

function deriveDiscountStatus(entry) {
  if (!entry) return 'unknown';
  if (entry.disabledAt) return 'disabled';
  const endsAt = entry.endsAt ? new Date(entry.endsAt) : null;
  if (endsAt && endsAt.getTime() <= Date.now()) return 'expired';
  const used = Number(entry.usageCount) || 0;
  const limit = entry.usageLimit;
  if (limit != null && used >= limit) return 'used_up';
  return 'active';
}

function formatDiscountForClient(entry) {
  const status = deriveDiscountStatus(entry);
  const used = Number(entry.usageCount) || 0;
  const limit = entry.usageLimit;
  const usageLabel =
    limit == null ? `${used} used` : `${used}/${limit} used`;

  return {
    ...entry,
    status,
    usageCount: used,
    usageLabel,
    shopifyAdminUrl: entry.shopifyAdminUrl || null,
  };
}

async function fetchDiscountUsageFromShopify(shop, entry) {
  if (!entry?.priceRuleId || !entry?.code) return entry;
  try {
    const res = await shop.get(`/price_rules/${entry.priceRuleId}/discount_codes.json`, {
      params: { limit: 50 },
    });
    const codes = res.data?.discount_codes || [];
    const match = codes.find((c) => c.code === entry.code);
    if (match && typeof match.usage_count === 'number') {
      return { ...entry, usageCount: match.usage_count };
    }
  } catch (_) {
    /* best-effort */
  }
  return entry;
}

async function enrichDiscountsList(clientId, entries, shopFactory) {
  const base = (entries || []).map((e) => formatDiscountForClient(e));
  if (!shopFactory) return base;

  try {
    const shop = await shopFactory();
    const enriched = await Promise.all(
      base.slice(0, 40).map((e) => fetchDiscountUsageFromShopify(shop, e))
    );
    return enriched.map((e) => formatDiscountForClient(e)).concat(base.slice(40));
  } catch (_) {
    return base;
  }
}

function buildShopifyAdminDiscountUrl(shopDomain, priceRuleId) {
  if (!shopDomain || !priceRuleId) return null;
  const host = String(shopDomain).replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${host}/admin/discounts/${priceRuleId}`;
}

module.exports = {
  resolveUsageLimit,
  deriveDiscountStatus,
  formatDiscountForClient,
  enrichDiscountsList,
  buildShopifyAdminDiscountUrl,
};
