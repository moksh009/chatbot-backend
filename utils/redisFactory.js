/**
 * Central Redis connection factory — reduces duplicate ioredis instances across
 * workers, queues, api cache, and webhook dedupe.
 *
 * Two singletons:
 *   • App Redis — general commands (cache, idempotency, socket pub when shared).
 *     In production, connects only when REDIS_URL is set (same as legacy redisClient).
 *   • Queue Redis — BullMQ + chat buffer; falls back to localhost when REDIS_URL
 *     is unset (matches legacy TaskQueue/MessageBuffer/NlpWorker behavior).
 * Both are skipped when Render internal Redis URL is used from a non-Render machine.
 */

const Redis = require('ioredis');
const log = require('./logger')('RedisFactory');

function shouldSkipInternalRedis() {
  const url = process.env.REDIS_URL || '';
  return url.includes('red-') && !process.env.RENDER;
}

function resolveAppRedisUrl() {
  if (shouldSkipInternalRedis()) return null;
  if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL) return null;
  return process.env.REDIS_URL || 'redis://localhost:6379';
}

function resolveQueueRedisUrl() {
  if (shouldSkipInternalRedis()) return null;
  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

let appRedisSingleton = null;
let queueRedisSingleton = null;

function sharedRetryStrategy(times) {
  if (times > 3) {
    log.warn('[Redis] Max retries reached, giving up.');
    return null;
  }
  return Math.min(times * 50, 2000);
}

function queueRetryStrategy(times) {
  if (times > 3) {
    log.error('[Redis] Queue connection failed persistently.');
    return null;
  }
  return Math.min(times * 100, 3000);
}

/**
 * App/session Redis — caching, dedupe, optional general use.
 * @returns {import('ioredis').Redis | null}
 */
function getAppRedis() {
  const url = resolveAppRedisUrl();
  if (!url) return null;
  if (appRedisSingleton) return appRedisSingleton;
  appRedisSingleton = new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy: sharedRetryStrategy
  });
  appRedisSingleton.on('error', (err) => log.warn('[Redis/App] Connection error:', err.message));
  appRedisSingleton.on('connect', () => log.info('[Redis/App] Connected successfully.'));
  return appRedisSingleton;
}

/**
 * BullMQ + high-volume Redis ops — localhost fallback in dev.
 * @returns {import('ioredis').Redis | null}
 */
function getQueueRedis() {
  const url = resolveQueueRedisUrl();
  if (!url) return null;
  if (queueRedisSingleton) return queueRedisSingleton;
  queueRedisSingleton = new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy: queueRetryStrategy
  });
  queueRedisSingleton.on('error', (err) => {
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      log.warn('[Redis/Queue] Unreachable:', err.message);
    } else {
      log.warn('[Redis/Queue] Error:', err.message);
    }
  });
  queueRedisSingleton.on('connect', () => log.info('[Redis/Queue] Connected.'));
  return queueRedisSingleton;
}

module.exports = {
  Redis,
  shouldSkipInternalRedis,
  resolveAppRedisUrl,
  resolveQueueRedisUrl,
  getAppRedis,
  getQueueRedis
};
