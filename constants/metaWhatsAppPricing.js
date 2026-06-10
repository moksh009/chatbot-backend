'use strict';

/**
 * Meta WhatsApp per-message list rates for India (INR).
 * @see https://developers.facebook.com/docs/whatsapp/pricing/
 * Effective April 2026 — marketing flat; utility/auth volume tiers apply at scale.
 */
const INDIA_RATES_INR = {
  MARKETING: 0.8631,
  UTILITY: 0.115,
  AUTHENTICATION: 0.115,
  AUTHENTICATION_INTERNATIONAL: 2.4971,
  SERVICE: 0,
};

const CATEGORY_ALIASES = {
  marketing: 'MARKETING',
  utility: 'UTILITY',
  authentication: 'AUTHENTICATION',
  'authentication-international': 'AUTHENTICATION_INTERNATIONAL',
  service: 'SERVICE',
};

function normalizeCategory(raw) {
  const u = String(raw || 'UTILITY').trim().toUpperCase().replace(/-/g, '_');
  if (INDIA_RATES_INR[u] != null) return u;
  const alias = CATEGORY_ALIASES[String(raw || '').toLowerCase()];
  return alias || 'UTILITY';
}

function rateInrForCategory(category) {
  const key = normalizeCategory(category);
  return INDIA_RATES_INR[key] ?? INDIA_RATES_INR.UTILITY;
}

function estimateCostInr(category, count = 1) {
  const n = Math.max(0, Number(count) || 0);
  return Math.round(n * rateInrForCategory(category) * 100) / 100;
}

/** Map automation context to likely Meta billing category. */
function categoryForContext({ contextType, automationSlotId, templateName } = {}) {
  const slot = String(automationSlotId || '').toLowerCase();
  const ctx = String(contextType || '').toLowerCase();
  const name = String(templateName || '').toLowerCase();

  if (
    ctx === 'abandoned_cart' ||
    slot.includes('cart') ||
    slot.includes('abandoned') ||
    name.includes('cart_recovery') ||
    name.includes('abandoned')
  ) {
    return 'MARKETING';
  }
  if (ctx === 'cod_prepaid' || name.includes('cod_prepaid') || name.includes('prepaid')) {
    return 'MARKETING';
  }
  if (ctx === 'admin_alert' || name.includes('admin_')) {
    return 'UTILITY';
  }
  if (ctx === 'campaign' || ctx === 'broadcast') {
    return 'MARKETING';
  }
  return 'UTILITY';
}

module.exports = {
  INDIA_RATES_INR,
  normalizeCategory,
  rateInrForCategory,
  estimateCostInr,
  categoryForContext,
};
