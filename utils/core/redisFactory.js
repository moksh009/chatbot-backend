/**
 * Central Redis connection factory — reduces duplicate ioredis instances across
 * workers, queues, api cache, and webhook dedupe.
 */

const Redis = require('ioredis');
const log = require('./logger')('RedisFactory');

/** Set REDIS_DISABLED=true for local API-only dev when Redis is not installed. */
function isRedisDisabled() {
  const flag = String(process.env.REDIS_DISABLED || '').toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  const url = String(process.env.REDIS_URL || '').trim().toLowerCase();
  if (url === 'false' || url === 'disabled' || url === 'off' || url === 'none') return true;
  return false;
}

function shouldSkipInternalRedis() {
  const url = process.env.REDIS_URL || '';
  return url.includes('red-') && !process.env.RENDER;
}

function resolveAppRedisUrl() {
  if (isRedisDisabled()) return null;
  if (shouldSkipInternalRedis()) return null;
  if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL) return null;
  return process.env.REDIS_URL || 'redis://localhost:6379';
}

function resolveQueueRedisUrl() {
  if (isRedisDisabled()) return null;
  if (shouldSkipInternalRedis()) return null;
  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

let appRedisSingleton = null;
let queueRedisSingleton = null;
let appRedisTestOverride = null;
let queueRedisTestOverride = undefined;
let redisDisabledLogged = false;
const errorThrottle = new Map();

function logRedisErrorThrottled(label, err) {
  const key = `${label}:${err?.code || err?.message || 'unknown'}`;
  const now = Date.now();
  const last = errorThrottle.get(key) || 0;
  if (now - last < 30_000) return;
  errorThrottle.set(key, now);
  const msg = err?.message || String(err);
  if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') {
    log.warn(`[Redis/${label}] Unreachable: ${msg}`);
  } else {
    log.warn(`[Redis/${label}] Error: ${msg}`);
  }
}

let devRedisGiveUpLogged = false;

/** Never return null — permanent reconnect (avoids stuck "Connection is closed"). */
function sharedRetryStrategy(times) {
  const isDev = process.env.NODE_ENV !== 'production';
  const maxDevRetries = Math.max(3, parseInt(process.env.REDIS_DEV_MAX_RETRIES || '8', 10) || 8);
  if (isDev && times > maxDevRetries) {
    if (!devRedisGiveUpLogged) {
      devRedisGiveUpLogged = true;
      log.warn(
        `[Redis] Stopped reconnecting after ${maxDevRetries} attempts (development). ` +
          'Install Redis on port 6379, or set REDIS_DISABLED=true in .env for API-only local dev.'
      );
    }
    return null;
  }
  const delay = Math.min(times * 200, 10000);
  if (times > 0 && times % 15 === 0) {
    log.warn(`[Redis] Reconnect attempt #${times} (next in ${delay}ms)`);
  }
  return delay;
}

function reconnectOnError(err) {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('READONLY') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('Connection is closed') ||
    msg.includes('Socket closed')
  );
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

function isTerminalRedisStatus(status) {
  return status === 'end' || status === 'close';
}

function isRedisReady(redis) {
  if (!redis) return false;
  const st = redis.status;
  return st === 'ready' || st === 'connect' || st === 'connecting' || st === 'reconnecting';
}

function createRedisClient(url, label) {
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: sharedRetryStrategy,
    reconnectOnError,
  });

  client.on('error', (err) => {
    logRedisErrorThrottled(label, err);
  });

  client.on('connect', () => {
    log.info(`[Redis/${label}] Connected.`);
    ensureNoEviction(client, label);
  });

  client.on('ready', () => {
    log.info(`[Redis/${label}] Ready.`);
  });

  client.on('close', () => {
    log.warn(`[Redis/${label}] Connection closed — will reconnect.`);
  });

  client.on('end', () => {
    log.warn(`[Redis/${label}] Connection ended — next use will recreate client.`);
    if (label === 'App' && appRedisSingleton === client) appRedisSingleton = null;
    if (label === 'Queue' && queueRedisSingleton === client) queueRedisSingleton = null;
  });

  return client;
}

async function logRedisHealth() {
  if (isRedisDisabled()) {
    if (!redisDisabledLogged) {
      redisDisabledLogged = true;
      log.warn(
        '[Redis] REDIS_DISABLED=true — cache, BullMQ queues, and webhook dedup are off. ' +
          'Fine for local API/UI dev; required for journeys, campaigns, and workers in production.'
      );
    }
    return;
  }
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

function getAppRedis() {
  if (appRedisTestOverride) return appRedisTestOverride;
  const url = resolveAppRedisUrl();
  if (!url) return null;
  if (appRedisSingleton && isTerminalRedisStatus(appRedisSingleton.status)) {
    try {
      appRedisSingleton.disconnect();
    } catch (_) {
      /* ignore */
    }
    appRedisSingleton = null;
  }
  if (!appRedisSingleton) {
    appRedisSingleton = createRedisClient(url, 'App');
  }
  return appRedisSingleton;
}

function getQueueRedis() {
  if (queueRedisTestOverride !== undefined) return queueRedisTestOverride;
  const url = resolveQueueRedisUrl();
  if (!url) return null;
  if (queueRedisSingleton && isTerminalRedisStatus(queueRedisSingleton.status)) {
    try {
      queueRedisSingleton.disconnect();
    } catch (_) {
      /* ignore */
    }
    queueRedisSingleton = null;
  }
  if (!queueRedisSingleton) {
    queueRedisSingleton = createRedisClient(url, 'Queue');
  }
  return queueRedisSingleton;
}

function __setAppRedisForTests(client) {
  appRedisTestOverride = client;
}

function __resetAppRedisForTests() {
  appRedisTestOverride = null;
  queueRedisTestOverride = undefined;
  appRedisSingleton = null;
  queueRedisSingleton = null;
}

function __setQueueRedisForTests(client) {
  queueRedisTestOverride = client;
}

module.exports = {
  Redis,
  isRedisDisabled,
  shouldSkipInternalRedis,
  resolveAppRedisUrl,
  resolveQueueRedisUrl,
  getAppRedis,
  getQueueRedis,
  isRedisReady,
  logRedisHealth,
  __setAppRedisForTests,
  __setQueueRedisForTests,
  __resetAppRedisForTests,
};
