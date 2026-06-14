'use strict';

const { getAppRedis } = require('../core/redisFactory');

const CAPTURE_LOCK_TTL_SEC = 30;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 120;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Serialize rapid-fire pixel capture upserts (live typing) per checkout/phone.
 * Exponential backoff: 120ms → 240ms → 480ms before proceeding without lock.
 */
async function withPixelCaptureLock(clientId, dedupeKey, fn) {
  if (!clientId || !dedupeKey || typeof fn !== 'function') {
    return fn();
  }

  const redis = getAppRedis();
  const lockKey = `pixel_capture:${clientId}:${String(dedupeKey).slice(0, 128)}`;
  const log = require('../core/logger')('PixelCaptureLock');

  if (redis) {
    let acquired = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      acquired = await redis.set(lockKey, '1', 'EX', CAPTURE_LOCK_TTL_SEC, 'NX');
      if (acquired) break;
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
      log.warn(`[LockContention] Retrying lock for ${dedupeKey} after ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delayMs);
    }
    if (!acquired) {
      log.error(`[LockFailed] Proceeding without lock for ${dedupeKey} after ${MAX_RETRIES} retries`);
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
