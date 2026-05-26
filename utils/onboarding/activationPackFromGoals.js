'use strict';

const { resolvePlanLimits } = require('../../config/planCatalog');
const { isTrialWindowActive, hasPaidEntitlements } = require('../core/accessFlags');

/** Goal → wizard feature toggles + playbook hint IDs (not MERCHANT_PLAYBOOK_STEPS ids). */
const GOAL_WIZARD_KEYS = {
  abandoned_cart: {
    enableAbandonedCart: true,
    cartNudgeMinutes1: 45,
    cartNudgeHours2: 8,
    cartNudgeHours3: 36,
  },
  order_status: {
    enableOrderTracking: true,
    enableAutoShopifyShippedWhatsApp: true,
  },
  support_bot: {
    enableFAQ: true,
    enableSupportEscalation: true,
    enableAIFallback: true,
  },
  post_purchase: {
    enableOrderConfirmTpl: true,
  },
};

const GOAL_PLAYBOOK_HINTS = {
  abandoned_cart: ['goal_abandoned_cart'],
  order_status: ['goal_order_status'],
  support_bot: ['goal_support_bot'],
  campaign_broadcasts: ['goal_campaigns'],
  post_purchase: ['goal_post_purchase'],
  coupons: ['goal_coupons'],
};

/** Features we never auto-enable from onboarding goals (paid / heavy / coming soon). */
const NEVER_AUTO_ENABLE = new Set([
  'enableReferral',
  'enableReviewCollection',
  'enableWarranty',
  'enableB2BWholesale',
  'enableCodToPrepaid',
  'enableMetaAdsTrigger',
  'enableInstagramTrigger',
  'enableReturnsRefunds',
]);

/**
 * Pure mapping: goals[] → { wizardFeatureUpdates, playbookSteps }.
 * @param {string[]} goals
 * @returns {{ wizardFeatureUpdates: Record<string, boolean|number>, playbookSteps: string[] }}
 */
function activationPackFromGoals(goals) {
  const list = Array.isArray(goals) ? goals.filter((g) => typeof g === 'string' && g.trim()) : [];
  const wizardFeatureUpdates = {};
  const playbookSteps = [];

  for (const goal of list) {
    const feat = GOAL_WIZARD_KEYS[goal];
    if (feat) Object.assign(wizardFeatureUpdates, feat);
    const hints = GOAL_PLAYBOOK_HINTS[goal];
    if (hints) playbookSteps.push(...hints);
  }

  for (const key of Object.keys(wizardFeatureUpdates)) {
    if (NEVER_AUTO_ENABLE.has(key)) delete wizardFeatureUpdates[key];
  }

  return {
    wizardFeatureUpdates,
    playbookSteps: [...new Set(playbookSteps)],
  };
}

/**
 * Apply plan / trial caps so trial merchants get goal activation without paid-only playbook paths.
 * @param {{ wizardFeatureUpdates: object, playbookSteps: string[] }} pack
 * @param {{ client?: object, subscription?: object|null, planSlug?: string }} ctx
 */
function filterActivationPackForPlan(pack, ctx = {}) {
  const client = ctx.client || {};
  const sub = ctx.subscription ?? null;
  const paid = ctx.paid === true || hasPaidEntitlements(client, sub);
  const trialLive = ctx.trialWindowActive === true || isTrialWindowActive(client, sub);

  const planSlug =
    trialLive && !paid
      ? 'trial'
      : String(ctx.planSlug || client.billing?.planSlug || client.plan || 'trial').toLowerCase();

  const limits = resolvePlanLimits(planSlug) || resolvePlanLimits('trial');
  const wizardFeatureUpdates = { ...pack.wizardFeatureUpdates };
  let playbookSteps = [...pack.playbookSteps];

  if (!limits.sequences) {
    playbookSteps = playbookSteps.filter((id) => id !== 'goal_post_purchase');
  }

  for (const key of Object.keys(wizardFeatureUpdates)) {
    if (NEVER_AUTO_ENABLE.has(key)) delete wizardFeatureUpdates[key];
  }

  return { wizardFeatureUpdates, playbookSteps };
}

/**
 * Build Mongo $set keys for wizardFeatures (dot notation only).
 * @param {Record<string, boolean|number|string>} updates
 * @returns {Record<string, unknown>}
 */
function wizardFeatureUpdatesToMongoSet(updates) {
  const $set = {};
  if (!updates || typeof updates !== 'object') return $set;
  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined) continue;
    $set[`wizardFeatures.${key}`] = val;
  }
  return $set;
}

module.exports = {
  activationPackFromGoals,
  filterActivationPackForPlan,
  wizardFeatureUpdatesToMongoSet,
  GOAL_WIZARD_KEYS,
  GOAL_PLAYBOOK_HINTS,
};
