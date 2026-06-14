'use strict';

const { getAppRedis } = require('../core/redisFactory');

const CAPTURE_LOCK_TTL_SEC = 30;

/**
 * Serialize rapid-fire pixel capture upserts (live typing) per checkout/phone.
 */
async function withPixelCaptureLock(clientId, dedupeKey, fn) {
  if (!clientId || !dedupeKey || typeof fn !== 'function') {
    return fn();
  }

  const redis = getAppRedis();
  const lockKey = `pixel_capture:${clientId}:${String(dedupeKey).slice(0, 128)}`;

  if (redis) {
    let acquired = await redis.set(lockKey, '1', 'EX', CAPTURE_LOCK_TTL_SEC, 'NX');
    if (!acquired) {
      // Log contention
      const log = require('../core/logger')('PixelCaptureLock');
      log.warn(`[LockContention] Retrying lock for ${dedupeKey} after 80ms`);
      await new Promise((r) => setTimeout(r, 80));
      acquired = await redis.set(lockKey, '1', 'EX', CAPTURE_LOCK_TTL_SEC, 'NX');
    }
    if (!acquired) {
      const log = require('../core/logger')('PixelCaptureLock');
      log.error(`[LockFailed] Proceeding without lock for ${dedupeKey} after 80ms retry`);
      return fn();
    }
  }

  try {
    return await fn();
  } finally {
    if (redis) {
      await redis.del(lockKey).catch(() => null);
    }
  }
}

module.exports = { withPixelCaptureLock, CAPTURE_LOCK_TTL_SEC };
