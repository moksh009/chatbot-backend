'use strict';

/** Legacy order-notification slots (pending/paid/shipped/delivered/cancelled/cod). Retired in
 *  May 2026 in favour of fulfillment + payment status rules, then narrowed again in Jun 2026
 *  to six delivery-journey rules (order placed + five courier events). */
const LEGACY_ORDER_NOTIFICATION_SLOTS = ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'cod'];

const ABANDONED_CART_SLOTS = ['followup_1', 'followup_2', 'followup_3'];

/**
 * The six order-status message rules on Order messages → Order updates.
 * Mirror frontend src/utils/commerceAutomationCatalog.js for label + tooltip parity.
 */
const ORDER_MESSAGE_STATUS_RULES = [
  {
    kind: 'fulfillment',
    status: 'unfulfilled',
    label: 'Order placed',
    tooltip:
      'Triggers immediately when a customer finishes checkout. Use this to send an instant order confirmation and a thank you message while their order status is "Unfulfilled."',
  },
  {
    kind: 'shipment',
    status: 'in_transit',
    label: 'In Transit',
    tooltip:
      'Triggers when the courier partner physically picks up the package from your warehouse and scans it. This sends as soon as the package is officially on its way to the customer\'s city.',
  },
  {
    kind: 'shipment',
    status: 'out_for_delivery',
    label: 'Out for Delivery',
    tooltip:
      'Triggers on the day of delivery when the courier agent scans the package and leaves the hub. Use this to alert customers to stay at home or keep cash ready for COD orders.',
  },
  {
    kind: 'shipment',
    status: 'delivered',
    label: 'Delivered',
    tooltip:
      'Triggers the exact moment the courier agent marks the parcel as successfully handed over.',
  },
  {
    kind: 'shipment',
    status: 'attempted_delivery',
    label: 'Attempted delivery',
    tooltip:
      'Triggers if the delivery agent tried to deliver the package but failed (e.g., customer unavailable, door locked, or incorrect address). Use this to urgently prompt the customer to co-ordinate a re-delivery.',
  },
  {
    kind: 'shipment',
    status: 'failure',
    label: 'Failed Delivery (RTO)',
    tooltip:
      'Triggers when the courier gives up after multiple failed delivery attempts and officially marks the package to return back to your warehouse (Return to Origin). Use this to notify the customer that their delivery has been canceled.',
  },
];

/** @deprecated Jun 2026 — only unfulfilled remains as "Order placed". */
const FULFILLMENT_STATUS_RULES = ORDER_MESSAGE_STATUS_RULES.filter((r) => r.kind === 'fulfillment');

/** Courier delivery events — driven by Shopify fulfillment shipment_status webhooks. */
const SHIPMENT_STATUS_RULES = ORDER_MESSAGE_STATUS_RULES.filter((r) => r.kind === 'shipment');

/** @deprecated Jun 2026 — payment-status rules retired from Order updates UI. */
const PAYMENT_STATUS_RULES = [];

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

/** ID prefix of every legacy order-notification rule we now retire. */
const LEGACY_ORDER_RULE_ID_PREFIX = 'sys_order_';

function isLegacyOrderRuleId(id) {
  return String(id || '').startsWith(LEGACY_ORDER_RULE_ID_PREFIX);
}

/** Retired Jun 2026 — old fulfillment (except unfulfilled) + all payment-status system rules. */
function isRetiredOrderStatusRule(rule) {
  const id = String(rule?.id || '');
  if (!id) return false;
  if (isLegacyOrderRuleId(id)) return true;
  if (id.startsWith('sys_financial_')) return true;
  if (id.startsWith('sys_fulfillment_') && id !== 'sys_fulfillment_unfulfilled') return true;
  return false;
}

/**
 * One-time config migration: copy template / toggle / mappings from retired rules
 * onto the Jun 2026 canonical six-rule set (only fills gaps on the target).
 */
const RETIRED_ORDER_RULE_MIGRATION_MAP = [
  ['sys_financial_paid', 'sys_fulfillment_unfulfilled'],
  ['sys_financial_pending', 'sys_fulfillment_unfulfilled'],
  ['sys_fulfillment_fulfilled', 'sys_shipment_in_transit'],
  ['sys_fulfillment_partial', 'sys_shipment_in_transit'],
];

function ruleHasMerchantConfig(rule) {
  if (!rule) return false;
  if (String(rule.templateName || '').trim()) return true;
  const body = rule.variableMappings?.body || {};
  if (Object.values(body).some((v) => v != null && v !== '')) return true;
  if (rule.isActive) return true;
  if (rule.emailConfig?.templateId || rule.emailConfig?.template) return true;
  return false;
}

function mergeConfigFromRetiredRule(target = {}, source = {}) {
  const patch = {};
  const targetTpl = String(target.templateName || '').trim();
  const sourceTpl = String(source.templateName || '').trim();
  if (!targetTpl && sourceTpl) patch.templateName = sourceTpl;

  const targetBody = target.variableMappings?.body || {};
  const sourceBody = source.variableMappings?.body || {};
  const targetHasMappings = Object.values(targetBody).some((v) => v != null && v !== '');
  const sourceHasMappings = Object.values(sourceBody).some((v) => v != null && v !== '');
  if (!targetHasMappings && sourceHasMappings) {
    patch.variableMappings = source.variableMappings;
    patch.customVariableValues = source.customVariableValues || {};
  }

  const effectiveTpl = patch.templateName || targetTpl;
  if (!target.isActive && source.isActive && effectiveTpl) {
    patch.isActive = true;
  }

  if (!target.emailConfig && source.emailConfig) {
    patch.emailConfig = source.emailConfig;
  } else if (target.emailConfig && source.emailConfig) {
    const targetEmailTpl = target.emailConfig?.templateId || target.emailConfig?.template;
    const sourceEmailTpl = source.emailConfig?.templateId || source.emailConfig?.template;
    if (!targetEmailTpl && sourceEmailTpl) {
      patch.emailConfig = source.emailConfig;
    }
  }

  if (Array.isArray(source.channels) && source.channels.length) {
    const targetChannels = Array.isArray(target.channels) ? target.channels : ['whatsapp'];
    const mergedChannels = [...new Set([...targetChannels, ...source.channels])];
    if (mergedChannels.length > targetChannels.length) {
      patch.channels = mergedChannels;
    }
  }

  const targetScope = String(target.triggerScope || 'every_order');
  const sourceScope = String(source.triggerScope || 'every_order');
  const sourceProducts = [
    ...(Array.isArray(source.productIds) ? source.productIds : []),
    ...(Array.isArray(source.targetProductIds) ? source.targetProductIds : []),
  ].filter(Boolean);
  if (
    sourceScope === 'specific_product' &&
    targetScope !== 'specific_product' &&
    sourceProducts.length
  ) {
    patch.triggerScope = 'specific_product';
    patch.productIds = source.productIds || sourceProducts;
    patch.targetProductIds = source.targetProductIds || sourceProducts;
    patch.productId = source.productId || sourceProducts[0] || '';
    patch.productTitle = source.productTitle || '';
  }

  return patch;
}

function applyRetiredRuleMigrations(existing = []) {
  if (!Array.isArray(existing) || !existing.length) return existing;
  const byId = new Map(existing.map((r) => [r.id, r]));
  const patches = new Map();

  const applyPatch = (targetId, sourceRule) => {
    if (!targetId || !sourceRule) return;
    const target = { ...(byId.get(targetId) || {}), ...(patches.get(targetId) || {}) };
    const patch = mergeConfigFromRetiredRule(target, sourceRule);
    if (!Object.keys(patch).length) return;
    patches.set(targetId, { ...(patches.get(targetId) || {}), ...patch });
  };

  for (const [fromId, toId] of RETIRED_ORDER_RULE_MIGRATION_MAP) {
    const source = byId.get(fromId);
    if (!source || !ruleHasMerchantConfig(source)) continue;

    if (fromId === 'sys_financial_pending') {
      const paid = byId.get('sys_financial_paid');
      const target = { ...(byId.get(toId) || {}), ...(patches.get(toId) || {}) };
      if (ruleHasMerchantConfig(paid) || String(target.templateName || '').trim()) continue;
    }

    applyPatch(toId, source);
  }

  if (!patches.size) return existing;
  return existing.map((rule) => (patches.has(rule.id) ? { ...rule, ...patches.get(rule.id) } : rule));
}

function orderMessageStatusRule(def) {
  if (def.kind === 'fulfillment') return fulfillmentStatusRule(def);
  return shipmentStatusRule(def);
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
    ...ORDER_MESSAGE_STATUS_RULES.map(orderMessageStatusRule),
    ...ABANDONED_CART_SLOTS.map((slot, i) => abandonedCartRule(slot, i + 1)),
  ];
}

function isSystemAutomation(automation) {
  return !!(automation?.meta?.system || String(automation?.id || '').startsWith('sys_'));
}

function mergeSystemAutomations(existing = []) {
  const migratedExisting = applyRetiredRuleMigrations(existing);
  const presets = buildSystemAutomations();
  const byId = new Map((migratedExisting || []).map((r) => [r.id, r]));
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
      meta: { ...preset.meta, ...(cur.meta || {}), tooltip: preset.meta?.tooltip },
    });
  }

  /** Surface custom rules merchants created in the past, but drop retired system rules. */
  for (const rule of migratedExisting) {
    if (presets.some((p) => p.id === rule.id)) continue;
    if (isLegacyOrderRuleId(rule.id)) continue;
    if (isRetiredOrderStatusRule(rule)) continue;
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
  ORDER_MESSAGE_STATUS_RULES,
  FULFILLMENT_STATUS_RULES,
  SHIPMENT_STATUS_RULES,
  PAYMENT_STATUS_RULES,
  CART_FOLLOWUP_MIN_MINUTES,
  CART_FOLLOWUP_DEFAULT_MINUTES,
  buildSystemAutomations,
  isSystemAutomation,
  isLegacyOrderRuleId,
  isRetiredOrderStatusRule,
  RETIRED_ORDER_RULE_MIGRATION_MAP,
  applyRetiredRuleMigrations,
  mergeSystemAutomations,
  validateCartFollowupDelay,
  cartFollowupSyncPatch,
  cartRecoveryVariableMappings,
};
