'use strict';

const { isProductTemplate } = require('./templateListPolicy');
const { isSystemExcluded } = require('./templatePolicy');

/** Per-rule WhatsApp template allowlist — keep in sync with frontend orderMessageTemplatePolicy.js */
const RULE_TEMPLATE_ALLOWLIST = {
  sys_fulfillment_unfulfilled: ['eco_order_confirmed', 'order_confirmation_v1', 'order_confirmed'],
  sys_shipment_in_transit: ['order_in_transit', 'eco_shipping_update'],
  sys_shipment_out_for_delivery: ['order_out_for_delivery'],
  sys_shipment_delivered: ['order_delivered_update', 'eco_delivered'],
  sys_shipment_attempted_delivery: ['delivery_attempt_failed'],
  sys_shipment_failure: ['rto_ndr_rescue'],
  sys_commerce_cod_confirm: ['cod_confirmation_v1'],
  sys_cart_followup_1: ['cart_recovery_1'],
  sys_cart_followup_2: ['cart_recovery_2'],
  sys_cart_followup_3: ['cart_recovery_3'],
};

const ORDER_MESSAGES_UNION = [
  ...new Set(Object.entries(RULE_TEMPLATE_ALLOWLIST)
    .filter(([id]) => !id.startsWith('sys_cart_'))
    .flatMap(([, names]) => names)),
];

const CART_RECOVERY_NAMES = ['cart_recovery_1', 'cart_recovery_2', 'cart_recovery_3'];

const FLOW_PICKER_EXCLUDED = [
  /^prod_/i,
  /^delitech_admin_/i,
  /^admin_human/i,
  /^test_run$/i,
  /^hello_world$/i,
];

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function isWizardProductTemplate(tpl) {
  if (!tpl) return false;
  if (isProductTemplate(tpl)) return true;
  const name = normalizeName(tpl.name);
  return FLOW_PICKER_EXCLUDED.some((re) => re.test(name));
}

function isOrderMessageTemplateName(name) {
  return ORDER_MESSAGES_UNION.includes(normalizeName(name));
}

function isCartRecoveryTemplateName(name) {
  const n = normalizeName(name);
  return CART_RECOVERY_NAMES.includes(n) || n.includes('cart_recovery');
}

function filterByAllowSet(list, allowSet, { keepSelectedName } = {}) {
  const allow = new Set(allowSet.map(normalizeName));
  if (keepSelectedName) allow.add(normalizeName(keepSelectedName));
  return (Array.isArray(list) ? list : []).filter((tpl) => {
    if (isWizardProductTemplate(tpl)) return false;
    if (isSystemExcluded(tpl)) return false;
    return allow.has(normalizeName(tpl.name));
  });
}

function filterTemplatesForOrderMessagesList(list) {
  return filterByAllowSet(list, ORDER_MESSAGES_UNION);
}

function filterTemplatesForCartRecoveryList(list) {
  return (Array.isArray(list) ? list : []).filter((tpl) => {
    if (isWizardProductTemplate(tpl)) return false;
    if (isSystemExcluded(tpl)) return false;
    return isCartRecoveryTemplateName(tpl.name);
  });
}

function filterTemplatesForOrderRule(ruleId, list, { selectedName } = {}) {
  const allow = RULE_TEMPLATE_ALLOWLIST[String(ruleId || '')];
  if (!allow) return filterTemplatesForOrderMessagesList(list);
  return filterByAllowSet(list, allow, { keepSelectedName: selectedName });
}

function filterTemplatesForFlowPicker(list) {
  return (Array.isArray(list) ? list : []).filter((tpl) => {
    if (isWizardProductTemplate(tpl)) return false;
    if (isSystemExcluded(tpl)) return false;
    return true;
  });
}

module.exports = {
  RULE_TEMPLATE_ALLOWLIST,
  ORDER_MESSAGES_UNION,
  CART_RECOVERY_NAMES,
  normalizeName,
  isOrderMessageTemplateName,
  isCartRecoveryTemplateName,
  isWizardProductTemplate,
  filterTemplatesForOrderMessagesList,
  filterTemplatesForCartRecoveryList,
  filterTemplatesForOrderRule,
  filterTemplatesForFlowPicker,
};
