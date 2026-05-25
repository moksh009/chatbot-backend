'use strict';

const AdLead = require('../../models/AdLead');
const ScoreTierConfig = require('../../models/ScoreTierConfig');
const { getAppRedis } = require('../core/redisFactory');
const SCORE_CAP = 100;
const { auditLog } = require('../../services/audit/auditWriter');

const DEFAULT_WEIGHTS = {
  inbound_message: 2,
  link_click: 5,
  add_to_cart: 15,
  checkout_initiated: 35,
  appointment: 40,
  sentiment_bonus: 10,
  vip_bonus: 50,
};

async function getTenantWeights(clientId) {
  const redis = getAppRedis();
  const key = `score_weights:${clientId}`;
  if (redis) {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  }
  const cfg = await ScoreTierConfig.findOne({ clientId }).select('weights').lean();
  const weights = { ...DEFAULT_WEIGHTS, ...(cfg?.weights || {}) };
  if (redis) await redis.set(key, JSON.stringify(weights), 'EX', 60);
  return weights;
}

function computeDecay(lead) {
  const last = lead.lastActivityAt || lead.updatedAt || lead.createdAt;
  if (!last) return 0;
  const hours = (Date.now() - new Date(last).getTime()) / 3600000;
  const days = Math.floor(hours / 24);
  return Math.min(20, days);
}

function buildBreakdown(lead, weights) {
  const inboundPts = Math.min(20, (lead.inboundMessageCount || 0) * weights.inbound_message);
  const linkPts = (lead.linkClicks || 0) * weights.link_click;
  const cartPts = (lead.addToCartCount || 0) * weights.add_to_cart;
  const checkoutPts = (lead.checkoutInitiatedCount || 0) * weights.checkout_initiated;
  const apptPts = (lead.appointmentsBooked || 0) * weights.appointment;
  const sentimentPts =
    (lead.sentimentScore || lead.recentSentimentTrend || 0) > 80 ? weights.sentiment_bonus : 0;
  const tagPts = (lead.tags || []).includes('VIP') ? weights.vip_bonus : 0;
  const decay = computeDecay(lead);
  const totalRaw =
    inboundPts + linkPts + cartPts + checkoutPts + apptPts + sentimentPts + tagPts - decay;
  const totalCapped = Math.max(0, Math.min(SCORE_CAP, totalRaw));
  let intentState = lead.intentState || 'COLD';
  if (totalCapped >= 90) intentState = 'HOT_VIP';
  else if (totalCapped >= 70) intentState = 'HOT';
  else if (totalCapped >= 40) intentState = 'WARM';
  else if (totalCapped >= 10) intentState = 'ENGAGED';
  if (lead.cartStatus === 'abandoned' && totalCapped < 70) intentState = 'ABANDONED';

  return {
    inbound_messages: { count: lead.inboundMessageCount || 0, points: inboundPts },
    link_clicks: { count: lead.linkClicks || 0, points: linkPts },
    add_to_cart: { count: lead.addToCartCount || 0, points: cartPts },
    checkout_initiated: { count: lead.checkoutInitiatedCount || 0, points: checkoutPts },
    appointments: { count: lead.appointmentsBooked || 0, points: apptPts },
    sentiment_bonus: { points: sentimentPts },
    tag_bonuses: tagPts ? [{ tag: 'VIP', points: tagPts }] : [],
    decay: { points: -decay },
    intent_state: intentState,
    totalRaw,
    totalCapped,
    updatedAt: new Date(),
  };
}

/** @deprecated Use scoringHelper.recomputeLeadScoreDocument — kept for test imports of buildBreakdown */
async function recomputeLeadScore(leadIdOrLead) {
  const { recomputeLeadScoreDocument } = require('../core/scoringHelper');
  return recomputeLeadScoreDocument(leadIdOrLead);
}

async function patchScoreWeights(clientId, weights, actor) {
  await ScoreTierConfig.findOneAndUpdate(
    { clientId },
    { $set: { weights, isActive: true } },
    { upsert: true }
  );
  const redis = getAppRedis();
  if (redis) await redis.del(`score_weights:${clientId}`);
  auditLog({
    category: 'role',
    action: 'scoring.weights_changed',
    clientId,
    actor,
    details: { weights },
  });
  return getTenantWeights(clientId);
}

module.exports = {
  recomputeLeadScore,
  buildBreakdown,
  getTenantWeights,
  patchScoreWeights,
  DEFAULT_WEIGHTS,
};
