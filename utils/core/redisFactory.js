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
/** @type {import('ioredis').Redis | object | null | undefined} Test override (phase 2 E2E). */
let appRedisTestOverride = null;
/** @type {import('ioredis').Redis | object | null | undefined} undefined = normal; null = force off. */
let queueRedisTestOverride = undefined;

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

let evictionWarningSent = false;

async function ensureNoEviction(redis, label) {
  if (!redis || process.env.REDIS_ENFORCE_NOEVICTION === 'false') return;
  if (evictionWarningSent) return;
  try {
    const current = await redis.config('GET', 'maxmemory-policy');
    const policy = Array.isArray(current) ? String(current[1] || '').toLowerCase() : '';
    if (policy === 'noeviction') return;
    await redis.config('SET', 'maxmemory-policy', 'noeviction');
    log.warn(`[Redis/${label}] Updated maxmemory-policy from "${policy || 'unknown'}" to "noeviction".`);
  } catch (err) {
    evictionWarningSent = true;
    log.warn(
      `[Redis/${label}] Cannot set noeviction via CONFIG (${err.message}). ` +
        'Set maxmemory-policy=noeviction in your Redis provider dashboard (required for BullMQ).'
    );
  }
}

/** Startup health — ping + log policy once */
async function logRedisHealth() {
  const redis = getAppRedis();
  if (!redis) {
    log.warn('[Redis] App Redis not configured (REDIS_URL unset in production).');
    return;
  }
  try {
    await redis.ping();
    log.info('[Redis] PING ok');
    try {
      const current = await redis.config('GET', 'maxmemory-policy');
      const policy = Array.isArray(current) ? current[1] : current;
      log.info(`[Redis] maxmemory-policy: ${policy || 'unknown'}`);
      if (policy && String(policy).toLowerCase() === 'allkeys-lru') {
        evictionWarningSent = true;
        log.warn(
          '[Redis] Policy is allkeys-lru — BullMQ jobs may be evicted. Use noeviction in provider settings.'
        );
      }
    } catch {
      await ensureNoEviction(redis, 'App');
    }
  } catch (err) {
    log.warn('[Redis] Health check failed:', err.message);
  }
}

/**
 * App/session Redis — caching, dedupe, optional general use.
 * @returns {import('ioredis').Redis | null}
 */
function getAppRedis() {
  if (appRedisTestOverride) return appRedisTestOverride;
  const url = resolveAppRedisUrl();
  if (!url) return null;
  if (appRedisSingleton) return appRedisSingleton;
  appRedisSingleton = new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy: sharedRetryStrategy
  });
  appRedisSingleton.on('error', (err) => log.warn('[Redis/App] Connection error:', err.message));
  appRedisSingleton.on('connect', () => {
    log.info('[Redis/App] Connected successfully.');
    ensureNoEviction(appRedisSingleton, 'App');
  });
  return appRedisSingleton;
}

/**
 * BullMQ + high-volume Redis ops — localhost fallback in dev.
 * @returns {import('ioredis').Redis | null}
 */
function getQueueRedis() {
  if (queueRedisTestOverride !== undefined) return queueRedisTestOverride;
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
  queueRedisSingleton.on('connect', () => {
    log.info('[Redis/Queue] Connected.');
    ensureNoEviction(queueRedisSingleton, 'Queue');
  });
  return queueRedisSingleton;
}

function __setAppRedisForTests(client) {
  appRedisTestOverride = client;
}

function __resetAppRedisForTests() {
  appRedisTestOverride = null;
  queueRedisTestOverride = undefined;
}

function __setQueueRedisForTests(client) {
  queueRedisTestOverride = client;
}

module.exports = {
  Redis,
  shouldSkipInternalRedis,
  resolveAppRedisUrl,
  resolveQueueRedisUrl,
  getAppRedis,
  getQueueRedis,
  logRedisHealth,
  __setAppRedisForTests,
  __setQueueRedisForTests,
  __resetAppRedisForTests,
};
