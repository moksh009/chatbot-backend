'use strict';

const Client = require('../../models/Client');
const { getAppRedis } = require('../core/redisFactory');

const CURSOR_KEY = 'cart_cron:fairness:cursor';
const CLIENT_IDS_CACHE_KEY = 'cart_cron:fairness:client_ids';
const CLIENT_IDS_CACHE_TTL_SEC = 120;

const ACTIVE_CLIENT_QUERY = {
  $or: [
    { 'automationFlows.id': 'abandoned_cart', 'automationFlows.isActive': true },
    { commerceAutomations: { $elemMatch: { 'meta.category': 'abandoned_cart', isActive: true } } },
  ],
};

async function listActiveCartClientIds() {
  const redis = getAppRedis();
  if (redis && redis.status === 'ready') {
    try {
      const cached = await redis.get(CLIENT_IDS_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch {
      /* fall through */
    }
  }

  const rows = await Client.find(ACTIVE_CLIENT_QUERY).select('clientId').lean();
  const ids = rows.map((r) => r.clientId).filter(Boolean).sort();

  if (redis && redis.status === 'ready' && ids.length) {
    await redis.set(CLIENT_IDS_CACHE_KEY, JSON.stringify(ids), 'EX', CLIENT_IDS_CACHE_TTL_SEC).catch(() => null);
  }

  return ids;
}

/**
 * Round-robin slice of active cart-recovery tenants (B6.3).
 * Redis cursor ensures no tenant starves when batch is capped.
 */
async function selectFairClientBatch(maxClients = 40) {
  const limit = Math.max(1, Number(maxClients) || 40);
  const ids = await listActiveCartClientIds();
  if (!ids.length) return [];

  const redis = getAppRedis();
  let cursor = 0;
  if (redis && redis.status === 'ready') {
    try {
      cursor = parseInt((await redis.get(CURSOR_KEY)) || '0', 10) || 0;
    } catch {
      cursor = 0;
    }
  }

  const picked = [];
  for (let i = 0; i < Math.min(limit, ids.length); i += 1) {
    picked.push(ids[(cursor + i) % ids.length]);
  }

  if (redis && redis.status === 'ready' && picked.length) {
    const next = (cursor + picked.length) % ids.length;
    await redis.set(CURSOR_KEY, String(next)).catch(() => null);
  }

  return Client.find({ clientId: { $in: picked } })
    .select('clientId nicheData wizardFeatures automationFlows shopDomain storeType commerceAutomations cartRecoveryConfig')
    .lean();
}

module.exports = {
  selectFairClientBatch,
  listActiveCartClientIds,
  ACTIVE_CLIENT_QUERY,
  CURSOR_KEY,
};
