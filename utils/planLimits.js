const Subscription = require('../models/Subscription');

const PLAN_LIMITS = {
  trial: {
    contacts: 100, messages: 1000, agents: 1, campaigns: 2,
    flows: 1, sequences: false, instagram: false, woocommerce: false,
    analyticsdays: 7, waflows: false
  },
  starter: {
    contacts: 1000, messages: 5000, agents: 1, campaigns: 3,
    flows: 2, sequences: false, instagram: false, woocommerce: false,
    analyticsdays: 7, waflows: false
  },
  growth: {
    contacts: 10000, messages: 50000, agents: 5, campaigns: -1,
    flows: 10, sequences: true, instagram: true, woocommerce: true,
    analyticsdays: 30, waflows: true
  },
  enterprise: {
    contacts: -1, messages: -1, agents: -1, campaigns: -1,
    flows: -1, sequences: true, instagram: true, woocommerce: true,
    analyticsdays: 90, waflows: true
  }
};

/**
 * Validates if a client has permissions or remaining tier limits for a specific feature.
 * @param {String} clientId The objective Client ID
 * @param {String} limitType Field inside PLAN_LIMITS ('contacts', 'sequences', etc.)
 * @returns {Promise<{allowed: Boolean, reason?: String, usage?: Number, limit?: Number|Boolean}>}
 */
async function checkLimit(clientId, limitType) {
  const sub = await Subscription.findOne({ clientId });
  if (!sub) return { allowed: false, reason: "No active subscription" };
  if (sub.status === "cancelled") return { allowed: false, reason: "Subscription cancelled" };
  if (sub.status === "frozen") return { allowed: false, reason: "Subscription frozen" };

  const plan = sub.plan || "trial";
  const limits = PLAN_LIMITS[plan];
  if (!limits) return { allowed: false, reason: "Unknown plan configuration" };

  const limit = limits[limitType];
  
  // Boolean locks (Gated features)
  if (limit === false) return { allowed: false, reason: `${limitType} not available on ${plan} plan` };
  
  // Unlimited hooks
  if (limit === -1) return { allowed: true };

  // Check current usage against integer-based limits
  if (typeof limit === 'number') {
      const usage = sub.usageThisPeriod?.[limitType] || 0;
      if (usage >= limit) {
        return {
          allowed: false,
          reason: `${limitType} limit reached (${usage}/${limit}). Upgrade your plan to increase limits.`,
          usage,
          limit
        };
      }
      return { allowed: true, usage, limit };
  }

  // Feature is allowed if it passes boolean and integer checks
  return { allowed: true };
}

/**
 * Safely atom-increments the target limit usage metric
 * @param {String} clientId The identifier
 * @param {String} usageType 'messages' | 'campaigns' | 'contacts'
 * @param {Number} by Incremental jump unit 
 */
async function incrementUsage(clientId, usageType, by = 1) {
  await Subscription.findOneAndUpdate(
    { clientId },
    { $inc: { [`usageThisPeriod.${usageType}`]: by } }
  );
}

module.exports = { checkLimit, incrementUsage, PLAN_LIMITS };
