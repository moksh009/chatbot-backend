'use strict';

const Client = require('../../models/Client');
const {
  CART_RECOVERY_DEFAULTS,
  CART_FOLLOWUP_MIN_MINUTES,
  CART_FOLLOWUP_DEFAULT_MINUTES,
  resolveCartNudgeDelay,
  clampDelayMinutes,
} = require('../../constants/cartRecoveryDefaults');

function getCartRecoveryConfig(client = {}) {
  const cfg = client.cartRecoveryConfig || {};
  const wf = client.wizardFeatures || {};

  return {
    promotionDelayMinutes: clampDelayMinutes(
      cfg.promotionDelayMinutes ?? wf.promotionDelayMinutes,
      5,
      CART_RECOVERY_DEFAULTS.promotionDelayMinutes
    ),
    step1DelayMinutes: clampDelayMinutes(
      cfg.step1DelayMinutes ??
        cfg.step1Delay ??
        wf.cartNudgeMinutes1,
      CART_FOLLOWUP_MIN_MINUTES.followup_1,
      CART_RECOVERY_DEFAULTS.step1DelayMinutes
    ),
    step2DelayMinutes: clampDelayMinutes(
      cfg.step2DelayMinutes ??
        (cfg.step2DelayHours != null ? Number(cfg.step2DelayHours) * 60 : null) ??
        (wf.cartNudgeHours2 != null ? Number(wf.cartNudgeHours2) * 60 : null),
      CART_FOLLOWUP_MIN_MINUTES.followup_2,
      CART_RECOVERY_DEFAULTS.step2DelayMinutes
    ),
    step3DelayMinutes: clampDelayMinutes(
      cfg.step3DelayMinutes ??
        (cfg.step3DelayHours != null ? Number(cfg.step3DelayHours) * 60 : null) ??
        (wf.cartNudgeHours3 != null ? Number(wf.cartNudgeHours3) * 60 : null),
      CART_FOLLOWUP_MIN_MINUTES.followup_3,
      CART_RECOVERY_DEFAULTS.step3DelayMinutes
    ),
    smartSendEnabled:
      cfg.smartSendEnabled !== undefined ? !!cfg.smartSendEnabled : CART_RECOVERY_DEFAULTS.smartSendEnabled,
    smartSendStartHour: Number(cfg.smartSendStartHour ?? CART_RECOVERY_DEFAULTS.smartSendStartHour),
    smartSendEndHour: Number(cfg.smartSendEndHour ?? CART_RECOVERY_DEFAULTS.smartSendEndHour),
    timezone: cfg.timezone || CART_RECOVERY_DEFAULTS.timezone,
    attributionWindowHours: Number(
      cfg.attributionWindowHours ?? CART_RECOVERY_DEFAULTS.attributionWindowHours
    ),
    discountEnabled: !!cfg.discountEnabled,
    discountStep2Pct: Number(cfg.discountStep2Pct || 0),
    discountStep3Pct: Number(cfg.discountStep3Pct || 0),
    abTestEnabled: cfg.abTestEnabled === true,
  };
}

function getCartRecoveryDelays(client = {}) {
  const config = getCartRecoveryConfig(client);
  const cartRules = (client.commerceAutomations || []).filter(
    (a) => a.meta?.category === 'abandoned_cart'
  );
  const ruleDelayMin = (slot) => {
    const r = cartRules.find((x) => x.meta?.systemSlot === slot);
    const n = Number(r?.delayMinutes);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  return {
    promotionDelayMin: config.promotionDelayMinutes,
    delay1Min:
      ruleDelayMin('followup_1') ??
      config.step1DelayMinutes,
    delay2Min:
      ruleDelayMin('followup_2') ??
      config.step2DelayMinutes,
    delay3Min:
      ruleDelayMin('followup_3') ??
      config.step3DelayMinutes,
    config,
  };
}

function computeNextPromotionAt(lead, promotionDelayMin) {
  if (!lead || lead.cartStatus !== 'active') return null;
  const anchor =
    lead.lastCartEventAt ||
    lead.contactCapturedAt ||
    lead.cartAbandonedAt ||
    lead.createdAt;
  if (!anchor) return null;
  return new Date(new Date(anchor).getTime() + promotionDelayMin * 60 * 1000);
}

function buildConfigPayload(client = {}) {
  const config = getCartRecoveryConfig(client);
  const { promotionDelayMin, delay1Min, delay2Min, delay3Min } = getCartRecoveryDelays(client);
  return {
    ...config,
    delays: {
      promotionDelayMinutes: promotionDelayMin,
      step1DelayMinutes: delay1Min,
      step2DelayMinutes: delay2Min,
      step3DelayMinutes: delay3Min,
    },
    minDelays: CART_FOLLOWUP_MIN_MINUTES,
    defaults: CART_RECOVERY_DEFAULTS,
  };
}

async function saveCartRecoveryConfig(clientId, patch = {}) {
  const allowedKeys = [
    'promotionDelayMinutes',
    'step1DelayMinutes',
    'step2DelayMinutes',
    'step3DelayMinutes',
    'smartSendEnabled',
    'smartSendStartHour',
    'smartSendEndHour',
    'timezone',
    'attributionWindowHours',
    'discountEnabled',
    'discountStep2Pct',
    'discountStep3Pct',
    'abTestEnabled',
  ];
  const safePatch = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      safePatch[key] = patch[key];
    }
  }

  const client = await Client.findOne({ clientId })
    .select('cartRecoveryConfig wizardFeatures commerceAutomations')
    .lean();
  if (!client) throw new Error('Client not found');

  const current = getCartRecoveryConfig(client);
  const next = {
    ...current,
    ...safePatch,
  };

  if (safePatch.step1DelayMinutes != null) {
    next.step1DelayMinutes = clampDelayMinutes(
      safePatch.step1DelayMinutes,
      CART_FOLLOWUP_MIN_MINUTES.followup_1,
      CART_FOLLOWUP_DEFAULT_MINUTES.followup_1
    );
  }
  if (safePatch.step2DelayMinutes != null) {
    next.step2DelayMinutes = clampDelayMinutes(
      safePatch.step2DelayMinutes,
      CART_FOLLOWUP_MIN_MINUTES.followup_2,
      CART_FOLLOWUP_DEFAULT_MINUTES.followup_2
    );
  }
  if (safePatch.step3DelayMinutes != null) {
    next.step3DelayMinutes = clampDelayMinutes(
      safePatch.step3DelayMinutes,
      CART_FOLLOWUP_MIN_MINUTES.followup_3,
      CART_FOLLOWUP_DEFAULT_MINUTES.followup_3
    );
  }
  if (safePatch.promotionDelayMinutes != null) {
    next.promotionDelayMinutes = clampDelayMinutes(
      safePatch.promotionDelayMinutes,
      5,
      CART_RECOVERY_DEFAULTS.promotionDelayMinutes
    );
  }

  if (safePatch.smartSendStartHour != null) {
    next.smartSendStartHour = Math.min(23, Math.max(0, Number(safePatch.smartSendStartHour) || 0));
  }
  if (safePatch.smartSendEndHour != null) {
    next.smartSendEndHour = Math.min(23, Math.max(0, Number(safePatch.smartSendEndHour) || 0));
  }

  const setFields = {
    'cartRecoveryConfig.promotionDelayMinutes': next.promotionDelayMinutes,
    'cartRecoveryConfig.step1DelayMinutes': next.step1DelayMinutes,
    'cartRecoveryConfig.step2DelayMinutes': next.step2DelayMinutes,
    'cartRecoveryConfig.step3DelayMinutes': next.step3DelayMinutes,
    'cartRecoveryConfig.smartSendEnabled': next.smartSendEnabled,
    'cartRecoveryConfig.smartSendStartHour': next.smartSendStartHour,
    'cartRecoveryConfig.smartSendEndHour': next.smartSendEndHour,
    'cartRecoveryConfig.timezone': next.timezone,
    'cartRecoveryConfig.attributionWindowHours': next.attributionWindowHours,
    'cartRecoveryConfig.discountEnabled': next.discountEnabled === true,
    'cartRecoveryConfig.discountStep2Pct': Math.min(50, Math.max(0, Number(next.discountStep2Pct) || 0)),
    'cartRecoveryConfig.discountStep3Pct': Math.min(50, Math.max(0, Number(next.discountStep3Pct) || 0)),
    'cartRecoveryConfig.abTestEnabled': next.abTestEnabled === true,
    'wizardFeatures.cartNudgeMinutes1': next.step1DelayMinutes,
    'wizardFeatures.cartNudgeHours2': Math.round(next.step2DelayMinutes / 60),
    'wizardFeatures.cartNudgeHours3': Math.round(next.step3DelayMinutes / 60),
  };

  await Client.findOneAndUpdate({ clientId }, { $set: setFields });

  const commerceAutomationService = require('./commerceAutomationService');
  const slots = [
    ['followup_1', next.step1DelayMinutes],
    ['followup_2', next.step2DelayMinutes],
    ['followup_3', next.step3DelayMinutes],
  ];
  for (const [slot, delayMinutes] of slots) {
    const rule = (client.commerceAutomations || []).find(
      (a) => a.meta?.systemSlot === slot && a.meta?.category === 'abandoned_cart'
    );
    if (rule?.id) {
      await commerceAutomationService.upsertAutomation(clientId, {
        id: rule.id,
        delayMinutes,
      });
    }
  }

  const updated = await Client.findOne({ clientId })
    .select('cartRecoveryConfig wizardFeatures commerceAutomations')
    .lean();
  return buildConfigPayload(updated);
}

module.exports = {
  getCartRecoveryConfig,
  getCartRecoveryDelays,
  computeNextPromotionAt,
  buildConfigPayload,
  saveCartRecoveryConfig,
};
