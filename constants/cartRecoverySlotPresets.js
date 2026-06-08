'use strict';

/**
 * Cart recovery Meta {{n}} slots — keep in sync with:
 * chatbot-dashboard-frontend-main/src/config/orderAutomationVariables.js → CART_RECOVERY_SLOT_PRESETS
 */

const CART_RECOVERY_BODY_SLOT_PRESETS = {
  1: ['first_name', 'product_name', 'cart_total'],
  2: ['first_name', 'product_name'],
  3: ['first_name', 'product_name', 'cart_total', 'discount_code'],
};

/** Meta body variable index per semantic field.
 *  WS-1 fix (June 2026): index 5 left a `{{4}}` gap which Meta rejects
 *  (variables must be consecutive starting at 1). Renumber discount_code
 *  → 4 to keep the body template valid for submission. */
const CART_RECOVERY_BODY_META_INDEX = {
  1: { first_name: 1, product_name: 2, cart_total: 3 },
  2: { first_name: 1, product_name: 2 },
  3: { first_name: 1, product_name: 2, cart_total: 3, discount_code: 4 },
};

const CART_RECOVERY_FIELD_TO_CONTEXT = {
  first_name: 'customerName',
  product_name: 'productName',
  cart_total: 'cartTotal',
  discount_code: 'discountCode',
  checkout_url: 'recoveryUrl',
};

const FRONTEND_MIRROR = {
  1: ['first_name', 'product_name', 'cart_total'],
  2: ['first_name', 'product_name'],
  3: ['first_name', 'product_name', 'cart_total', 'discount_code'],
};

function cartRecoveryVariableMappings(stepNum) {
  const step = Number(stepNum);
  const preset = CART_RECOVERY_BODY_SLOT_PRESETS[step] || CART_RECOVERY_BODY_SLOT_PRESETS[1];
  const indexMap = CART_RECOVERY_BODY_META_INDEX[step] || CART_RECOVERY_BODY_META_INDEX[1];
  const body = {};
  for (const field of preset) {
    const idx = indexMap[field];
    if (idx != null) body[String(idx)] = field;
  }
  return {
    body,
    buttons: { 0: 'checkout_url' },
  };
}

function resolveCartRecoveryFieldValue(field, context = {}, opts = {}) {
  const ctxKey = CART_RECOVERY_FIELD_TO_CONTEXT[field];
  let val = context[ctxKey];
  if (field === 'cart_total' && (val == null || val === '')) val = '—';
  if (field === 'discount_code') {
    val = opts.discountCode || val || context.discountCode || 'SAVE10';
  }
  if (val == null) val = '';
  return String(val).slice(0, field === 'discount_code' ? 64 : 256);
}

/**
 * Build ordered Meta body parameters for cart_recovery_1/2/3.
 * Preserves non-sequential {{5}} on step 3 (four body params for slots 1,2,3,5).
 */
function buildCartRecoveryBodyParameters(stepNum, context = {}, opts = {}) {
  const step = Number(stepNum);
  const preset = CART_RECOVERY_BODY_SLOT_PRESETS[step] || CART_RECOVERY_BODY_SLOT_PRESETS[1];
  return preset.map((field) => ({
    type: 'text',
    text: resolveCartRecoveryFieldValue(field, context, opts),
  }));
}

function planCartRuleActivation(readiness = {}) {
  if (!readiness.allTemplatesApproved) {
    return { count: 0, templateNames: [] };
  }
  return {
    count: 3,
    templateNames: ['cart_recovery_1', 'cart_recovery_2', 'cart_recovery_3'],
  };
}

module.exports = {
  CART_RECOVERY_BODY_SLOT_PRESETS,
  CART_RECOVERY_BODY_META_INDEX,
  CART_RECOVERY_FIELD_TO_CONTEXT,
  FRONTEND_MIRROR,
  cartRecoveryVariableMappings,
  buildCartRecoveryBodyParameters,
  resolveCartRecoveryFieldValue,
  planCartRuleActivation,
};
