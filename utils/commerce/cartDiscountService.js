'use strict';

const log = require('../core/logger')('CartDiscount');
const { getCartRecoveryConfig } = require('./cartRecoveryConfigService');

/**
 * Resolve dynamic discount for cart recovery step 2/3 (B2.6).
 */
async function resolveCartStepDiscount(client, lead, stepNum = 3) {
  const step = Number(stepNum);
  if (step < 2 || step > 3) return { discountCode: '', templateOverride: null, pct: 0 };

  const cfg = getCartRecoveryConfig(client);
  if (!cfg.discountEnabled || String(client?.storeType || '').toLowerCase() !== 'shopify') {
    return { discountCode: '', templateOverride: null, pct: 0 };
  }

  const pct = step === 2 ? Number(cfg.discountStep2Pct || 0) : Number(cfg.discountStep3Pct || 0);
  if (!pct || pct <= 0) {
    return { discountCode: '', templateOverride: null, pct: 0 };
  }

  try {
    const { generatePriceRuleAndDiscount } = require('../shopify/shopifyHelper');
    const discount = await generatePriceRuleAndDiscount(client.clientId, pct);
    return {
      discountCode: discount?.code || '',
      templateOverride: null,
      pct,
    };
  } catch (err) {
    log.warn(`[CartDiscount] step ${step} failed for ${client.clientId}: ${err.message}`);
    return { discountCode: '', templateOverride: null, pct: 0 };
  }
}

module.exports = { resolveCartStepDiscount };
