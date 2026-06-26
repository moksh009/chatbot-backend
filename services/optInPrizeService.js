'use strict';

const { generateUniqueCode, createShopifyDiscount } = require('./optInCouponService');

function validatePrizeProbabilities(prizes) {
  const list = Array.isArray(prizes) ? prizes : [];
  if (!list.length) return { valid: false, sum: 0, message: 'At least one prize slice is required.' };
  const sum = list.reduce((s, p) => s + (Number(p.probability) || 0), 0);
  if (sum !== 100) {
    return { valid: false, sum, message: `Prize probabilities must sum to 100 (currently ${sum}).` };
  }
  return { valid: true, sum: 100, message: '' };
}

/**
 * Weighted random prize pick — server authoritative.
 */
function pickWeightedPrize(prizes, random = Math.random()) {
  const list = Array.isArray(prizes) ? prizes : [];
  const active = list
    .map((prize, index) => ({ prize, index }))
    .filter((x) => Number(x.prize.probability) > 0);
  if (!active.length) return { prize: null, index: -1 };

  const total = active.reduce((s, x) => s + Number(x.prize.probability), 0);
  let roll = random * total;
  for (let i = 0; i < active.length; i++) {
    roll -= Number(active[i].prize.probability);
    if (roll <= 0) return { prize: active[i].prize, index: active[i].index };
  }
  const last = active[active.length - 1];
  return { prize: last.prize, index: last.index };
}

async function claimPrizeCoupon(clientId, tool, prize) {
  if (!prize || prize.couponMode === 'lose') {
    return { code: '', isLose: true, source: 'lose' };
  }

  if (prize.couponMode === 'fixed') {
    const code = String(prize.couponCode || '').trim();
    return { code, isLose: !code, source: 'fixed' };
  }

  if (prize.couponMode === 'unique') {
    const code = generateUniqueCode(tool._id || tool.id);
    if (prize.autoCreateOnShopify !== false) {
      try {
        const result = await createShopifyDiscount(clientId, {
          code,
          discountType: prize.discountType || 'percentage',
          discountValue: prize.discountValue ?? 10,
          minimumOrderAmount: prize.minimumOrderAmount ?? 0,
          usageLimit: 1,
        });
        return { code: result.code, isLose: false, source: 'unique', priceRuleId: result.priceRuleId };
      } catch (e) {
        console.warn('[optInPrize] unique coupon create failed', e.message);
        return { code, isLose: false, source: 'unique_fallback' };
      }
    }
    return { code, isLose: false, source: 'unique_local' };
  }

  return { code: '', isLose: true, source: 'none' };
}

module.exports = {
  validatePrizeProbabilities,
  pickWeightedPrize,
  claimPrizeCoupon,
};
