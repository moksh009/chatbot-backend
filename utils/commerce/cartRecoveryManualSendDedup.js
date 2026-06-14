'use strict';

const { getAppRedis } = require('../core/redisFactory');

const CART_DEDUP_TTL_SEC = 48 * 3600;

async function markCartRecoverySent(clientId, phoneOrEmail, stepNum) {
  const redis = getAppRedis();
  if (!redis || redis.status !== 'ready' || !phoneOrEmail) return;
  const key = `cart_recovery:${clientId}:${phoneOrEmail}:step${stepNum}`;
  try {
    await redis.set(key, '1', 'EX', CART_DEDUP_TTL_SEC);
  } catch {
    /* non-fatal */
  }
}

module.exports = { markCartRecoverySent };
