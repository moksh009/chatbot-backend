'use strict';

const { getAppRedis } = require('../core/redisFactory');

const VISITOR_TTL_SEC = 300;
const log = require('../core/logger')('PixelActiveVisitors');

function activeVisitorsKey(clientId) {
  return `pixel:active:${String(clientId).trim()}`;
}

/**
 * Track storefront session activity (page_view, cart, checkout) with 5-minute TTL.
 * Uses a sorted set scored by last-seen timestamp.
 */
async function touchActiveVisitor(clientId, sessionId) {
  const sid = String(sessionId || '').trim().slice(0, 128);
  if (!clientId || !sid) return null;

  const redis = getAppRedis();
  if (!redis) return null;

  const key = activeVisitorsKey(clientId);
  const now = Date.now();
  const cutoff = now - VISITOR_TTL_SEC * 1000;

  try {
    await redis.zadd(key, now, sid);
    await redis.zremrangebyscore(key, 0, cutoff);
    await redis.expire(key, VISITOR_TTL_SEC + 120);
    const count = await redis.zcard(key);

    if (global.io) {
      global.io.to(`client_${clientId}`).emit('pixel:visitor-count', {
        clientId,
        count,
        updatedAt: new Date().toISOString(),
      });
    }

    return count;
  } catch (err) {
    log.warn(`touchActiveVisitor failed: ${err.message}`);
    return null;
  }
}

async function getActiveVisitorCount(clientId) {
  if (!clientId) return 0;
  const redis = getAppRedis();
  if (!redis) return 0;

  const key = activeVisitorsKey(clientId);
  const cutoff = Date.now() - VISITOR_TTL_SEC * 1000;

  try {
    await redis.zremrangebyscore(key, 0, cutoff);
    return await redis.zcard(key);
  } catch {
    return 0;
  }
}

module.exports = {
  touchActiveVisitor,
  getActiveVisitorCount,
  VISITOR_TTL_SEC,
};
