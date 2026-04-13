const Subscription = require('../models/Subscription');

const PLAN_LIMITS = {
  trial: {
    contacts: 100, messages: 1000, agents: 1, campaigns: 2,
    flows: 1, sequences: false, instagram: false, woocommerce: false,
    analyticsdays: 7, waflows: false, aiSegments: false, aiCalls: 50
  },
  starter: {
    contacts: 1000, messages: 5000, agents: 1, campaigns: 3,
    flows: 2, sequences: false, instagram: false, woocommerce: false,
    analyticsdays: 7, waflows: false, aiSegments: false, aiCalls: 100
  },
  growth: {
    contacts: 10000, messages: 50000, agents: 5, campaigns: -1,
    flows: 10, sequences: true, instagram: true, woocommerce: true,
    analyticsdays: 30, waflows: true, aiSegments: false, aiCalls: 500
  },
  enterprise: {
    contacts: -1, messages: -1, agents: -1, campaigns: -1,
    flows: -1, sequences: true, instagram: true, woocommerce: true,
    analyticsdays: 90, waflows: true, aiSegments: true, aiCalls: -1
  },
  "cx agent (v1)": {
    contacts: 1000, messages: 5000, agents: 1, campaigns: 3,
    flows: 2, sequences: false, instagram: false, woocommerce: false,
    analyticsdays: 7, waflows: false, aiSegments: false, aiCalls: 100
  },
  "cx agent (v2)": {
    contacts: -1, messages: -1, agents: -1, campaigns: -1,
    flows: -1, sequences: true, instagram: true, woocommerce: true,
    analyticsdays: 90, waflows: true, aiSegments: true, aiCalls: -1
  }
};

async function checkLimit(identifier, limitType) {
  // --- BLOCK 6: ENTERPRISE OVERRIDE & GOD MODE ---
  const Client = require('../models/Client');
  const mongoose = require('mongoose');

  let query = { clientId: identifier };
  if (mongoose.Types.ObjectId.isValid(identifier)) {
    query = { $or: [{ _id: identifier }, { clientId: identifier }] };
  }

  const client = await Client.findOne(query).lean();
  const targetClientId = client?.clientId || identifier;
  
  const LIFETIME_CLIENTS = ['topedge_admin', 'delitech_smarthomes'];
  if (client?.isLifetimeAdmin || LIFETIME_CLIENTS.includes(targetClientId)) {
    return { allowed: true, limit: Infinity, usage: 0, isOverride: true };
  }

  const sub = await Subscription.findOne({ clientId: targetClientId });
  if (!sub) return { allowed: false, reason: "No active subscription", code: "NO_SUBSCRIPTION" };
  if (sub.status === "frozen") return { allowed: false, reason: "Subscription frozen", code: "ACCOUNT_FROZEN" };

  const plan = sub.plan?.toLowerCase() || "trial";
  const limits = PLAN_LIMITS[plan];
  if (!limits) return { allowed: false, reason: "Unknown plan configuration", code: "PLAN_ERROR" };

  const limit = limits[limitType];
  
  // Boolean locks (Gated features)
  if (limit === false) return { 
    allowed: false, 
    reason: `${limitType} not available on ${plan} plan`,
    code: "LIMIT_REACHED" 
  };
  
  // Unlimited hooks
  if (limit === -1) return { allowed: true };

  // Check current usage against integer-based limits
  if (typeof limit === 'number') {
      const usage = sub.usageThisPeriod?.[limitType] || 0;
      if (usage >= limit) {
        return {
          allowed: false,
          reason: `${limitType} limit reached (${usage}/${limit}). Upgrade your plan to increase limits.`,
          code: "LIMIT_REACHED",
          usage,
          limit
        };
      }
      return { allowed: true, usage, limit };
  }

  return { allowed: true };
}

/**
 * Safely atom-increments the target limit usage metric
 * @param {String|ObjectId} identifier The identifier
 * @param {String} usageType 'messages' | 'campaigns' | 'contacts'
 * @param {Number} by Incremental jump unit 
 */
async function incrementUsage(identifier, usageType, by = 1) {
    const Client = require('../models/Client');
    const mongoose = require('mongoose');
    
    let query = { clientId: identifier };
    if (mongoose.Types.ObjectId.isValid(identifier)) {
      query = { $or: [{ _id: identifier }, { clientId: identifier }] };
    }
  
    const client = await Client.findOne(query).select('clientId');
    const targetClientId = client?.clientId || identifier;

    await Subscription.findOneAndUpdate(
        { clientId: targetClientId },
        { $inc: { [`usageThisPeriod.${usageType}`]: by } }
    );
}


module.exports = { checkLimit, incrementUsage, PLAN_LIMITS };
