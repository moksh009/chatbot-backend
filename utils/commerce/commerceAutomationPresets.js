'use strict';

const ORDER_NOTIFICATION_SLOTS = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

const ABANDONED_CART_SLOTS = ['followup_1', 'followup_2', 'followup_3'];

/** Minimum delay after cart abandoned (minutes). User may increase, not decrease. */
const CART_FOLLOWUP_MIN_MINUTES = {
  followup_1: 15,
  followup_2: 2 * 60,
  followup_3: 24 * 60,
};

const CART_FOLLOWUP_DEFAULT_MINUTES = {
  followup_1: 45,
  followup_2: 8 * 60,
  followup_3: 36 * 60,
};

function cartRecoveryVariableMappings(stepNum) {
  const step = Number(stepNum);
  if (step === 2) {
    return { body: { 1: 'first_name', 2: 'product_name' }, buttons: { 0: 'checkout_url' } };
  }
  if (step >= 3) {
    return {
      body: { 1: 'first_name', 2: 'product_name', 3: 'cart_total', 5: 'discount_code' },
      buttons: { 0: 'checkout_url' },
    };
  }
  return {
    body: { 1: 'first_name', 2: 'product_name', 3: 'cart_total' },
    buttons: { 0: 'checkout_url' },
  };
}

function orderNotificationRule(slot) {
  const labels = {
    pending: 'Order Pending',
    paid: 'Order Paid',
    shipped: 'Order Shipped',
    delivered: 'Order Delivered',
    cancelled: 'Order Cancelled',
  };
  return {
    id: `sys_order_${slot}`,
    name: labels[slot] || `Order ${slot}`,
    triggerType: 'order_status',
    event: slot,
    matchType: 'exact',
    sku: '',
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
    meta: {
      system: true,
      category: 'order_notification',
      systemSlot: slot,
      locked: true,
    },
  };
}

function abandonedCartRule(slot, stepNum) {
  const labels = {
    followup_1: 'Followup 1',
    followup_2: 'Followup 2',
    followup_3: 'Followup 3',
  };
  const delay = CART_FOLLOWUP_DEFAULT_MINUTES[slot];
  return {
    id: `sys_cart_${slot}`,
    name: labels[slot] || `Followup ${stepNum}`,
    triggerType: 'abandoned_cart',
    event: 'abandoned',
    matchType: 'exact',
    sku: '',
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
  };
}

function buildSystemAutomations() {
  return [
    ...ORDER_NOTIFICATION_SLOTS.map(orderNotificationRule),
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
    const presetBody = preset.variableMappings?.body || {};
    const hasCurMappings = Object.values(curBody).some((v) => v != null && v !== '');
    const variableMappings = hasCurMappings
      ? cur.variableMappings
      : preset.variableMappings;

    merged.push({
      ...preset,
      ...cur,
      name: preset.name,
      triggerType: preset.triggerType,
      event: preset.event,
      variableMappings,
      meta: { ...preset.meta, ...(cur.meta || {}) },
    });
  }

  for (const rule of existing) {
    if (!presets.some((p) => p.id === rule.id)) merged.push(rule);
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
  ORDER_NOTIFICATION_SLOTS,
  ABANDONED_CART_SLOTS,
  CART_FOLLOWUP_MIN_MINUTES,
  CART_FOLLOWUP_DEFAULT_MINUTES,
  buildSystemAutomations,
  isSystemAutomation,
  mergeSystemAutomations,
  validateCartFollowupDelay,
  cartFollowupSyncPatch,
};
