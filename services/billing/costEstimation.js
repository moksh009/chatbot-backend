'use strict';

const { INDIA_RATES_INR } = require('../../constants/metaWhatsAppPricing');

/** India list rates — Meta per-message billing. Source: constants/metaWhatsAppPricing.js */
const META_MARKETING_INR = INDIA_RATES_INR.MARKETING;
const META_UTILITY_INR = INDIA_RATES_INR.UTILITY;
const META_SERVICE_INR = INDIA_RATES_INR.SERVICE;
const AI_PER_1K_TOKENS_INR = 0.15;

/**
 * @param {{ marketingCount?: number, utilityCount?: number }} params
 */
function estimateMetaBreakdown({ marketingCount = 0, utilityCount = 0 } = {}) {
  const m = Math.max(0, Math.round(Number(marketingCount) || 0));
  const u = Math.max(0, Math.round(Number(utilityCount) || 0));
  const marketing_inr = Math.round(m * META_MARKETING_INR);
  const utility_inr = Math.round(u * META_UTILITY_INR);
  return {
    marketing_count: m,
    utility_count: u,
    marketing_inr,
    utility_inr,
    service_inr: 0,
    meta_subtotal_inr: marketing_inr + utility_inr,
    rates: {
      marketing_per_message_inr: META_MARKETING_INR,
      utility_per_message_inr: META_UTILITY_INR,
      service_per_message_inr: META_SERVICE_INR,
      pricing_model: 'per_message',
    },
    disclaimer:
      'Meta charges per delivered template message by category. Service replies in the 24h customer window are free.',
  };
}

/**
 * Legacy tenant rollup — splits WhatsApp volume into marketing / utility when counts omitted.
 */
function estimateTenantCost({ usage = {}, planPriceInr = 0, marketingCount, utilityCount } = {}) {
  const wa = Number(usage.whatsappSent || usage.messagesSent || 0);
  const email = Number(usage.emailSent || 0);
  const aiTokens = Number(usage.aiTokens || usage.geminiTokens || 0);

  let mCount = marketingCount;
  let uCount = utilityCount;
  if (mCount == null && uCount == null && wa > 0) {
    mCount = Math.round(wa * 0.35);
    uCount = Math.max(0, wa - mCount);
  }

  const meta = estimateMetaBreakdown({
    marketingCount: mCount ?? 0,
    utilityCount: uCount ?? 0,
  });

  const email_cost = Math.round(email * 0.1);
  const ai_gemini = Math.round((aiTokens / 1000) * AI_PER_1K_TOKENS_INR);
  const storage = 50;
  const meta_messages = meta.meta_subtotal_inr;
  const total = meta_messages + email_cost + ai_gemini + storage;

  return {
    meta_messages,
    meta_breakdown: meta,
    email: email_cost,
    ai_gemini,
    storage,
    total,
    plan_price: planPriceInr,
    margin_estimate: planPriceInr - total,
    disclaimer: 'Estimates only — actual Meta bills depend on template category and delivery.',
  };
}

module.exports = {
  estimateTenantCost,
  estimateMetaBreakdown,
  META_MARKETING_INR,
  META_UTILITY_INR,
  META_SERVICE_INR,
};
