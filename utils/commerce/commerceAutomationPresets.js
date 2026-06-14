'use strict';

/** Legacy order-notification slots (pending/paid/shipped/delivered/cancelled/cod). Retired in
 *  May 2026 in favour of the new fulfillment + payment status rule sets below. We keep the slot
 *  list around for the migration / cleanup helpers (they detect and drop these from existing
 *  client documents on the next list call). */
const LEGACY_ORDER_NOTIFICATION_SLOTS = ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'cod'];

const ABANDONED_CART_SLOTS = ['followup_1', 'followup_2', 'followup_3'];

/** Fulfillment status rules surfaced in the Order Updates tab. Mirror frontend
 *  src/utils/commerceAutomationCatalog.js for tooltip + label parity. */
const FULFILLMENT_STATUS_RULES = [
  {
    status: 'unfulfilled',
    label: 'Unfulfilled',
    tooltip: 'The order has been placed, but no items have been packed or shipped yet',
  },
  {
    status: 'partial',
    label: 'Partially Fulfilled',
    tooltip: 'Only some items in the order have been shipped',
  },
  {
    status: 'fulfilled',
    label: 'Fulfilled',
    tooltip: 'All items in the order have been packed, assigned a tracking number, and shipped',
  },
  {
    status: 'on_hold',
    label: 'On Hold',
    tooltip: 'Fulfillment is temporarily paused by an app or by the merchant',
  },
  {
    status: 'scheduled',
    label: 'Scheduled',
    tooltip: 'The fulfillment is set for a specific future date, typical for subscriptions',
  },
];

/** Delivery tracking rules — driven by courier updates on Shopify fulfillments
 *  (`fulfillments/create` + `fulfillments/update` webhooks, `shipment_status` field).
 *  Third-party logistics partners (Shiprocket, Delhivery, etc.) push these into
 *  Shopify, and we mirror them to WhatsApp. Mirror frontend
 *  src/utils/commerceAutomationCatalog.js for label + tooltip parity. */
const SHIPMENT_STATUS_RULES = [
  {
    status: 'in_transit',
    label: 'In Transit',
    tooltip: 'The courier has picked up the package and it is on the way',
  },
  {
    status: 'out_for_delivery',
    label: 'Out for Delivery',
    tooltip: 'The package is with the delivery agent and will arrive today',
  },
  {
    status: 'delivered',
    label: 'Delivered',
    tooltip: 'The courier confirmed the package was delivered to the customer',
  },
  {
    status: 'attempted_delivery',
    label: 'Delivery Attempt Failed',
    tooltip: 'The courier tried to deliver but could not — ask the customer to confirm address or availability',
  },
  {
    status: 'failure',
    label: 'Delivery Failed',
    tooltip: 'The courier marked the shipment as failed — rescue the order before it returns to origin (RTO)',
  },
];

const PAYMENT_STATUS_RULES = [
  {
    status: 'pending',
    label: 'Pending',
    tooltip: 'Payment is being processed, or it is a Cash on Delivery',
  },
  {
    status: 'authorized',
    label: 'Authorized',
    tooltip: 'Payment is verified but not yet captured by the merchant',
  },
  {
    status: 'paid',
    label: 'Paid',
    tooltip: 'Payment successfully captured and completed',
  },
  {
    status: 'partially_paid',
    label: 'Partially Paid',
    tooltip: 'Only a portion of the order total has been paid',
  },
  {
    status: 'refunded',
    label: 'Refunded',
    tooltip: 'The full payment amount was sent back to the customer',
  },
  {
    status: 'partially_refunded',
    label: 'Partially Refunded',
    tooltip: 'Only a portion of the payment was sent back',
  },
  {
    status: 'voided',
    label: 'Voided',
    tooltip: 'The payment authorization was cancelled before any money changed hands',
  },
];

const { cartRecoveryVariableMappings } = require('../../constants/cartRecoverySlotPresets');
const { defaultEmailConfigForRule } = require('../../constants/prebuiltOrderEmailTemplates');

function dualChannelDefaults(ruleId) {
  return {
    channels: ['whatsapp'],
    emailConfig: defaultEmailConfigForRule(ruleId),
  };
}

const {
  CART_FOLLOWUP_MIN_MINUTES,
  CART_FOLLOWUP_DEFAULT_MINUTES,
} = require('../../constants/cartRecoveryDefaults');

function fulfillmentStatusRule({ status, label, tooltip }) {
  const ruleId = `sys_fulfillment_${status}`;
  return {
    id: ruleId,
    name: label,
    triggerType: 'order_status',
    triggerStatusType: 'fulfillment',
    triggerStatus: status,
    event: status,
    matchType: 'exact',
    sku: '',
    triggerScope: 'every_order',
    targetProductIds: [],
    productIds: [],
    productId: '',
    productTitle: '',
    variantId: '',
    actionType: 'send_template',
    templateName: '',
    sequenceId: '',
    language: 'en',
    delayMinutes: 0,
    imageUrl: '',
    isActive: false,
    variableMappings: { body: {} },
    customVariableValues: {},
    isDeletable: false,
    meta: {
      system: true,
      category: 'order_notification',
      group: 'fulfillment_status',
      systemSlot: `fulfillment_${status}`,
      tooltip,
      locked: true,
    },
    ...dualChannelDefaults(ruleId),
  };
}

function shipmentStatusRule({ status, label, tooltip }) {
  const ruleId = `sys_shipment_${status}`;
  return {
    id: ruleId,
    name: label,
    triggerType: 'order_status',
    triggerStatusType: 'shipment',
    triggerStatus: status,
    event: status,
    matchType: 'exact',
    sku: '',
    triggerScope: 'every_order',
    targetProductIds: [],
    productIds: [],
    productId: '',
    productTitle: '',
    variantId: '',
    actionType: 'send_template',
    templateName: '',
    sequenceId: '',
    language: 'en',
    delayMinutes: 0,
    imageUrl: '',
    isActive: false,
    variableMappings: { body: {} },
    customVariableValues: {},
    isDeletable: false,
    meta: {
      system: true,
      category: 'order_notification',
      group: 'shipment_status',
      systemSlot: `shipment_${status}`,
      tooltip,
      locked: true,
    },
    ...dualChannelDefaults(ruleId),
  };
}

function paymentStatusRule({ status, label, tooltip }) {
  const ruleId = `sys_financial_${status}`;
  return {
    id: ruleId,
    name: label,
    triggerType: 'order_status',
    triggerStatusType: 'financial',
    triggerStatus: status,
    event: status,
    matchType: 'exact',
    sku: '',
    triggerScope: 'every_order',
    targetProductIds: [],
    productIds: [],
    productId: '',
    productTitle: '',
    variantId: '',
    actionType: 'send_template',
    templateName: '',
    sequenceId: '',
    language: 'en',
    delayMinutes: 0,
    imageUrl: '',
    isActive: false,
    variableMappings: { body: {} },
    customVariableValues: {},
    isDeletable: false,
    meta: {
      system: true,
      category: 'order_notification',
      group: 'payment_status',
      systemSlot: `financial_${status}`,
      tooltip,
      locked: true,
    },
    ...dualChannelDefaults(ruleId),
  };
}

/** ID prefix of every legacy order-notification rule we now retire. */
const LEGACY_ORDER_RULE_ID_PREFIX = 'sys_order_';

function isLegacyOrderRuleId(id) {
  return String(id || '').startsWith(LEGACY_ORDER_RULE_ID_PREFIX);
}

function abandonedCartRule(slot, stepNum) {
  const ruleId = `sys_cart_${slot}`;
  const labels = {
    followup_1: 'Followup 1',
    followup_2: 'Followup 2',
    followup_3: 'Followup 3',
  };
  const delay = CART_FOLLOWUP_DEFAULT_MINUTES[slot];
  return {
    id: ruleId,
    name: labels[slot] || `Followup ${stepNum}`,
    triggerType: 'abandoned_cart',
    event: 'abandoned',
    matchType: 'exact',
    sku: '',
    triggerScope: 'every_order',
    targetProductIds: [],
    productId: '',
    productTitle: '',
    variantId: '',
    actionType: 'send_template',
    templateName: '',
    sequenceId: '',
    language: 'en',
    delayMinutes: delay,
    imageUrl: '',
    isActive: false,
    variableMappings: cartRecoveryVariableMappings(stepNum),
    customVariableValues: {},
    meta: {
      system: true,
      category: 'abandoned_cart',
      systemSlot: slot,
      followupStep: stepNum,
      minDelayMinutes: CART_FOLLOWUP_MIN_MINUTES[slot],
      locked: true,
    },
    ...dualChannelDefaults(ruleId),
  };
}

function buildSystemAutomations() {
  return [
    ...FULFILLMENT_STATUS_RULES.map(fulfillmentStatusRule),
    ...SHIPMENT_STATUS_RULES.map(shipmentStatusRule),
    ...PAYMENT_STATUS_RULES.map(paymentStatusRule),
    ...ABANDONED_CART_SLOTS.map((slot, i) => abandonedCartRule(slot, i + 1)),
  ];
}

function isSystemAutomation(automation) {
  return !!(automation?.meta?.system || String(automation?.id || '').startsWith('sys_'));
}

function mergeSystemAutomations(existing = []) {
  const presets = buildSystemAutomations();
  const byId = new Map((existing || []).map((r) => [r.id, r]));
  const merged = [];

  for (const preset of presets) {
    const cur = byId.get(preset.id);
    if (!cur) {
      merged.push(preset);
      continue;
    }
    const curBody = cur.variableMappings?.body || {};
    const hasCurMappings = Object.values(curBody).some((v) => v != null && v !== '');
    const variableMappings = hasCurMappings
      ? cur.variableMappings
      : preset.variableMappings;

    merged.push({
      ...preset,
      ...cur,
      name: preset.name,
      triggerType: preset.triggerType,
      triggerStatus: preset.triggerStatus,
      triggerStatusType: preset.triggerStatusType,
      event: preset.event,
      variableMappings,
      channels: Array.isArray(cur.channels) ? cur.channels : preset.channels,
      emailConfig: cur.emailConfig != null ? cur.emailConfig : preset.emailConfig,
      isDeletable: false,
      meta: { ...preset.meta, ...(cur.meta || {}) },
    });
  }

  /** Surface custom rules merchants created in the past, but quietly drop the retired
   *  legacy `sys_order_*` rules so the UI never shows them again. */
  for (const rule of existing) {
    if (presets.some((p) => p.id === rule.id)) continue;
    if (isLegacyOrderRuleId(rule.id)) continue;
    merged.push(rule);
  }

  return merged;
}

function validateCartFollowupDelay(automation) {
  if (automation?.meta?.category !== 'abandoned_cart') return null;
  const slot = automation.meta?.systemSlot;
  const min = CART_FOLLOWUP_MIN_MINUTES[slot];
  if (!min) return null;
  const delay = Number(automation.delayMinutes || 0);
  if (delay < min) {
    const human =
      min >= 60 * 24
        ? `${min / (60 * 24)} day(s)`
        : min >= 60
          ? `${min / 60} hour(s)`
          : `${min} minute(s)`;
    return `Delay cannot be less than ${human} after the cart is abandoned.`;
  }
  return null;
}

/** Persist cart followup delays + templates to wizardFeatures / nicheData for cron. */
function cartFollowupSyncPatch(automation) {
  if (automation?.meta?.category !== 'abandoned_cart') return {};
  const slot = automation.meta?.systemSlot;
  const tpl = automation.templateName || '';
  const delay = Number(automation.delayMinutes || 0);

  const patch = { wizardFeatures: {}, nicheData: {} };
  if (slot === 'followup_1') {
    patch.wizardFeatures.cartNudgeMinutes1 = delay;
    if (tpl) patch.nicheData.abandonedTpl15m = tpl;
  } else if (slot === 'followup_2') {
    patch.wizardFeatures.cartNudgeHours2 = Math.max(2, Math.round(delay / 60));
    if (tpl) patch.nicheData.abandonedTpl2h = tpl;
  } else if (slot === 'followup_3') {
    patch.wizardFeatures.cartNudgeHours3 = Math.max(24, Math.round(delay / 60));
    if (tpl) patch.nicheData.abandonedTpl24h = tpl;
  }
  return patch;
}

module.exports = {
  LEGACY_ORDER_NOTIFICATION_SLOTS,
  ABANDONED_CART_SLOTS,
  FULFILLMENT_STATUS_RULES,
  SHIPMENT_STATUS_RULES,
  PAYMENT_STATUS_RULES,
  CART_FOLLOWUP_MIN_MINUTES,
  CART_FOLLOWUP_DEFAULT_MINUTES,
  buildSystemAutomations,
  isSystemAutomation,
  isLegacyOrderRuleId,
  mergeSystemAutomations,
  validateCartFollowupDelay,
  cartFollowupSyncPatch,
  cartRecoveryVariableMappings,
};
