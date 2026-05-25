'use strict';

const META_PER_MSG_INR = 0.85;
const AI_PER_1K_TOKENS_INR = 0.15;

function estimateTenantCost({ usage = {}, planPriceInr = 0 }) {
  const wa = Number(usage.whatsappSent || usage.messagesSent || 0);
  const email = Number(usage.emailSent || 0);
  const aiTokens = Number(usage.aiTokens || usage.geminiTokens || 0);
  const meta_messages = Math.round(wa * META_PER_MSG_INR);
  const email_cost = Math.round(email * 0.1);
  const ai_gemini = Math.round((aiTokens / 1000) * AI_PER_1K_TOKENS_INR);
  const storage = 50;
  const total = meta_messages + email_cost + ai_gemini + storage;
  return {
    meta_messages,
    email: email_cost,
    ai_gemini,
    storage,
    total,
    plan_price: planPriceInr,
    margin_estimate: planPriceInr - total,
    disclaimer: 'Estimates only — actual Meta/email bills may differ.',
  };
}

module.exports = { estimateTenantCost };
