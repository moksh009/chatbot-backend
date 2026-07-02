'use strict';

const DEFAULT_COD_PREPAID_DISCOUNT_LABEL = 'Prepaid Discount';

function resolveCodPrepaidDiscountLabel(discountName) {
  const trimmed = String(discountName || '').trim();
  return trimmed || DEFAULT_COD_PREPAID_DISCOUNT_LABEL;
}

function buildCodPrepaidAppliedDiscount({ discountValue, discountValueType, discountName } = {}) {
  const value = Number(discountValue);
  if (!Number.isFinite(value) || value <= 0) return null;

  return {
    description: resolveCodPrepaidDiscountLabel(discountName),
    value,
    valueType: discountValueType === 'PERCENTAGE' ? 'PERCENTAGE' : 'FIXED_AMOUNT',
  };
}

module.exports = {
  DEFAULT_COD_PREPAID_DISCOUNT_LABEL,
  resolveCodPrepaidDiscountLabel,
  buildCodPrepaidAppliedDiscount,
};
