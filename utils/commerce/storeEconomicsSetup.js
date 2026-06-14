'use strict';

function asNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * True when the merchant has entered real cost inputs (not an all-zero / auto-default config).
 * Requires product COGS plus at least one operational cost bucket so margins are not fake 100%.
 */
function hasEconomicsInputs(config, products = []) {
  if (!config) return false;

  if (config.codAccepted !== true && config.codAccepted !== false) return false;

  const hasProductCogs = (products || []).some((p) => asNum(p.cogs) > 0);
  if (!hasProductCogs) return false;

  const hasLogistics = asNum(config.deliveryCostPerOrder) > 0;
  const hasMarketing = asNum(config.cacPerCustomer) > 0;
  const hasFees =
    asNum(config.gatewayFeeRate) > 0 || asNum(config.shopifyTransactionFeeRate) > 0;
  const hasPackaging =
    config.packagingMode === 'per_product'
      ? (products || []).some((p) => asNum(p.packagingCost) > 0)
      : asNum(config.uniformPackagingCost) > 0;
  const hasRto =
    asNum(config.totalRtoRate) > 0 ||
    asNum(config.codRtoRate) > 0 ||
    asNum(config.prepaidRtoRate) > 0;
  const hasOverheads = asNum(config.fixedOverheadsPerOrder) > 0;

  return hasLogistics || hasMarketing || hasFees || hasPackaging || hasRto || hasOverheads;
}

/**
 * Dashboard may render only when setup was explicitly finished AND inputs exist.
 */
function isEconomicsSetupReady(config, products = []) {
  return !!config?.setupCompleted && hasEconomicsInputs(config, products);
}

module.exports = {
  hasEconomicsInputs,
  isEconomicsSetupReady,
};
