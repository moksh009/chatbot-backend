const Subscription = require('../models/Subscription');
const { PLAN_LIMITS, normalizePlanSlug } = require('../config/planCatalog');
const {
  isTrialWindowActive,
  hasPaidActiveSubscription,
  resolveSubscriptionForClient,
  ensureTrialSubscriptionRecord
} = require('./accessFlags');

function effectivePlanKey(sub, client) {
  if (hasPaidActiveSubscription(sub)) {
    return normalizePlanSlug(sub.plan);
  }
  if (isTrialWindowActive(client)) {
    return 'trial';
  }
  const master = (client?.plan || 'CX Agent (V1)').toLowerCase().trim();
  if (PLAN_LIMITS[master]) return master;
  return 'cx agent (v1)';
}

async function checkLimit(identifier, limitType) {
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

  if (!client) {
    return { allowed: false, reason: 'Workspace not found', code: 'NO_CLIENT' };
  }

  let sub = await resolveSubscriptionForClient(client);
  if (!sub && isTrialWindowActive(client)) {
    await ensureTrialSubscriptionRecord(client.clientId);
    sub = await resolveSubscriptionForClient(client);
  }

  const trialLive = isTrialWindowActive(client);
  const paid = hasPaidActiveSubscription(sub);

  if (!sub && !trialLive) {
    return { allowed: false, reason: 'No active subscription', code: 'NO_SUBSCRIPTION' };
  }

  if (!trialLive && !paid) {
    return {
      allowed: false,
      reason: 'Your trial has ended. Upgrade to continue using this feature.',
      code: 'TRIAL_ENDED'
    };
  }

  if (sub?.status === 'frozen') {
    return { allowed: false, reason: 'Subscription frozen', code: 'ACCOUNT_FROZEN' };
  }

  const planKey = effectivePlanKey(sub, client);
  const limits = PLAN_LIMITS[planKey] || PLAN_LIMITS.trial;
  if (!limits) {
    return { allowed: false, reason: 'Unknown plan configuration', code: 'PLAN_ERROR' };
  }

  const limit = limits[limitType];

  if (limit === false) {
    return {
      allowed: false,
      reason: `${limitType} is not included on your current plan. Upgrade to unlock this capability.`,
      code: 'FEATURE_NOT_IN_PLAN'
    };
  }

  if (limit === -1) return { allowed: true };

  if (typeof limit === 'number') {
    const usage = sub?.usageThisPeriod?.[limitType] || 0;
    if (usage >= limit) {
      return {
        allowed: false,
        reason: `${limitType} limit reached (${usage}/${limit}) for this billing period. Upgrade your plan or wait for the next reset.`,
        code: 'LIMIT_REACHED',
        usage,
        limit
      };
    }
    return { allowed: true, usage, limit };
  }

  return { allowed: true };
}

async function incrementUsage(identifier, usageType, by = 1) {
  const Client = require('../models/Client');
  const mongoose = require('mongoose');

  let query = { clientId: identifier };
  if (mongoose.Types.ObjectId.isValid(identifier)) {
    query = { $or: [{ _id: identifier }, { clientId: identifier }] };
  }

  const client = await Client.findOne(query).select('clientId trialActive trialEndsAt isLifetimeAdmin').lean();
  const targetClientId = client?.clientId || identifier;
  if (!targetClientId || typeof targetClientId !== 'string') return;

  await ensureTrialSubscriptionRecord(targetClientId);

  await Subscription.findOneAndUpdate(
    { clientId: targetClientId },
    {
      $inc: { [`usageThisPeriod.${usageType}`]: by },
      $setOnInsert: {
        clientId: targetClientId,
        plan: 'trial',
        status: 'trial',
        billingCycle: 'none',
        amount: 0
      }
    },
    { upsert: true }
  );
}

module.exports = { checkLimit, incrementUsage, PLAN_LIMITS, effectivePlanKey };
