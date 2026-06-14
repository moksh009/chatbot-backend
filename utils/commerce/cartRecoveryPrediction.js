'use strict';

const { CART_RECOVERY_STEP_PROBABILITIES } = require('../../constants/cartRecoveryDefaults');

/**
 * Predicted recovery value for a lead (NEW-2): cartValue × step probability.
 */
function predictRecoveryValue(cartValue, recoveryStep = 0) {
  const value = Math.max(0, Number(cartValue) || 0);
  const step = Math.min(3, Math.max(0, Number(recoveryStep) || 0));
  const probability =
    CART_RECOVERY_STEP_PROBABILITIES[step] ?? CART_RECOVERY_STEP_PROBABILITIES[0];
  return Math.round(value * probability * 100) / 100;
}

module.exports = { predictRecoveryValue, CART_RECOVERY_STEP_PROBABILITIES };
