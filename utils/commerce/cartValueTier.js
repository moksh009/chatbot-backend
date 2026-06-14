'use strict';

const { CART_VALUE_TIER_THRESHOLDS } = require('../../constants/cartRecoveryDefaults');

function cartValueTier(value) {
  const v = Number(value) || 0;
  if (v >= CART_VALUE_TIER_THRESHOLDS.high) return 'high';
  if (v >= CART_VALUE_TIER_THRESHOLDS.medium) return 'medium';
  return 'low';
}

module.exports = { cartValueTier };
