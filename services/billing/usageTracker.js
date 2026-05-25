'use strict';

const Client = require('../../models/Client');
const Subscription = require('../../models/Subscription');
const { resolvePlanLimits } = require('../../config/planCatalog');
const log = require('../../utils/core/logger')('UsageTracker');

const COUNTER_ALIASES = {
  messages: 'messagesSent',
  messagesSent: 'messagesSent',
  aiCalls: 'aiCallsMade',
  aiCallsMade: 'aiCallsMade',
  campaigns: 'campaignsLaunched',
  campaignsLaunched: 'campaignsLaunched',
  campaignsSent: 'campaignsLaunched',
  contacts: 'contactsImported',
  contactsImported: 'contactsImported',
  leadsCreated: 'contactsImported',
  flowsPublished: 'flowsPublished',
  templatesSubmitted: 'templatesSubmitted',
};

function normalizeKey(key) {
  return COUNTER_ALIASES[key] || key;
}

function tripwireLegacyClientUsage(clientId, key) {
  log.warn(`[tripwire] legacy Client.usage read attempted clientId=${clientId} key=${key}`);
}

async function getOrCreateSubscription(clientId) {
  let sub = await Subscription.findOne({ clientId });
  if (sub) return sub;
  const client = await Client.findOne({ clientId }).select('plan subscriptionPlan').lean();
  const plan = client?.subscriptionPlan || client?.plan || 'diy_lite';
  sub = await Subscription.create({
    clientId,
    plan,
    status: 'active',
    usageThisPeriod: {
      messagesSent: 0,
      aiCallsMade: 0,
      campaignsLaunched: 0,
      contactsImported: 0,
      sequencesActive: 0,
      flowsPublished: 0,
      templatesSubmitted: 0,
      metaTemplateApprovals: 0,
    },
  });
  return sub;
}

async function checkLimit({ clientId, key }) {
  const canon = normalizeKey(key);
  const client = await Client.findOne({ clientId }).select('plan subscriptionPlan').lean();
  const sub = await Subscription.findOne({ clientId }).lean();
  const planKey = sub?.plan || client?.subscriptionPlan || client?.plan || 'diy_lite';
  const limits = resolvePlanLimits(planKey);
  const limitMap = {
    messagesSent: limits.messages,
    aiCallsMade: limits.aiCalls ?? limits.aiCallsMade ?? 500,
    campaignsLaunched: limits.campaigns,
    contactsImported: limits.contacts ?? limits.leads,
    flowsPublished: limits.flows ?? -1,
    templatesSubmitted: limits.templates ?? -1,
  };
  const max = limitMap[canon] ?? limits[canon] ?? -1;
  const current = sub?.usageThisPeriod?.[canon] ?? 0;
  if (max < 0) return { allowed: true, current, max, remaining: Infinity };
  return {
    allowed: current < max,
    current,
    max,
    remaining: Math.max(0, max - current),
  };
}

async function incrementUsage({ clientId, key, by = 1 }) {
  const canon = normalizeKey(key);
  const sub = await getOrCreateSubscription(clientId);
  const path = `usageThisPeriod.${canon}`;
  const updated = await Subscription.findByIdAndUpdate(
    sub._id,
    { $inc: { [path]: by } },
    { new: true }
  );
  return updated?.usageThisPeriod?.[canon] ?? 0;
}

async function resetPeriod(clientId) {
  const sub = await getOrCreateSubscription(clientId);
  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + 1);
  sub.usageThisPeriod = {
    messagesSent: 0,
    aiCallsMade: 0,
    campaignsLaunched: 0,
    contactsImported: 0,
    sequencesActive: 0,
    flowsPublished: 0,
    templatesSubmitted: 0,
    metaTemplateApprovals: 0,
  };
  sub.periodStart = now;
  sub.periodEnd = end;
  await sub.save();
  return sub;
}

module.exports = {
  checkLimit,
  incrementUsage,
  resetPeriod,
  normalizeKey,
};
