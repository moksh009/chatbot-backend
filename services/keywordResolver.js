'use strict';

const { findMatchingRule } = require('../utils/core/rulesEngine');
const KeywordTrigger = require('../models/KeywordTrigger');
const { getAppRedis } = require('../utils/core/redisFactory');
const { isSmartRulesEngineEnabled } = require('../utils/core/featureFlags');
const log = require('../utils/core/logger')('KeywordResolver');

const CACHE_TTL = 60;

async function getKeywordTriggers(clientId) {
  const redis = getAppRedis();
  const cacheKey = `keywords:${clientId}`;
  if (redis) {
    const raw = await redis.get(cacheKey);
    if (raw) return JSON.parse(raw);
  }
  const rows = await KeywordTrigger.find({ clientId, isActive: true }).sort({ priority: 1 }).lean();
  if (redis) {
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(rows));
  }
  return rows;
}

function matchKeywordTrigger(triggers, message, context = {}) {
  const text = String(message || '').toLowerCase().trim();
  if (!text) return null;
  for (const t of triggers) {
    const keywords = Array.isArray(t.keywords) ? t.keywords : [t.keyword].filter(Boolean);
    for (const kw of keywords) {
      const k = String(kw || '').toLowerCase().trim();
      if (!k) continue;
      if (t.matchType === 'exact' && text === k) return { type: 'keyword', match: t, action: t.action };
      if (t.matchType === 'starts_with' && text.startsWith(k)) return { type: 'keyword', match: t, action: t.action };
      if (text.includes(k)) return { type: 'keyword', match: t, action: t.action };
    }
  }
  return null;
}

/**
 * Unified keyword + behavior rule resolution (Phase 4 Module 8).
 */
async function findMatchingTrigger({ client, clientId, message, context = {} }) {
  const cid = clientId || client?.clientId;

  if (isSmartRulesEngineEnabled()) {
    const behaviorRules = client?.behaviorRules || client?.automationRules || [];
    const behavior = findMatchingRule(behaviorRules, message, context);
    if (behavior) {
      return { type: 'behavior', match: behavior, action: behavior.actions };
    }
  }

  const triggers = await getKeywordTriggers(cid);
  const kw = matchKeywordTrigger(triggers, message, context);
  if (kw) return kw;
  return null;
}

function invalidateKeywordCache(clientId) {
  const redis = getAppRedis();
  if (redis) redis.del(`keywords:${clientId}`).catch((e) => log.warn(e.message));
}

module.exports = {
  findMatchingTrigger,
  invalidateKeywordCache,
  matchKeywordTrigger,
};
