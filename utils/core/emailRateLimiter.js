'use strict';

const log = require('./logger')('EmailRateLimiter');
const { getAppRedis, isRedisReady } = require('./redisFactory');

function yyyymmdd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function dailyLimitKey(clientId, day = yyyymmdd()) {
  return `email:daily:${clientId}:${day}`;
}

function getDailyLimit() {
  const n = parseInt(String(process.env.EMAIL_DAILY_LIMIT || '450'), 10);
  return Number.isFinite(n) && n > 0 ? n : 450;
}

/** ioredis uses lowercase `incrby`; node-redis v4+ uses `incrBy`. */
async function redisIncrBy(redis, key, count) {
  const n = Math.max(1, Number(count) || 1);
  if (typeof redis.incrby === 'function') {
    return redis.incrby(key, n);
  }
  if (typeof redis.incrBy === 'function') {
    return redis.incrBy(key, n);
  }
  if (n === 1 && typeof redis.incr === 'function') {
    return redis.incr(key);
  }
  if (typeof redis.incr === 'function') {
    for (let i = 0; i < n; i += 1) {
      await redis.incr(key);
    }
    return n;
  }
  throw new Error('Redis client has no incr/incrby command');
}

async function checkEmailDailyLimit(clientId, emailsToSend = 1) {
  const limit = getDailyLimit();
  const redis = getAppRedis();
  if (!redis || !isRedisReady(redis)) {
    return { allowed: true, remaining: limit, limit, redisUnavailable: true };
  }

  const key = dailyLimitKey(clientId);
  const sent = parseInt((await redis.get(key)) || '0', 10) || 0;
  const remaining = Math.max(0, limit - sent);

  if (sent + emailsToSend > limit) {
    return { allowed: false, remaining, limit, sent };
  }
  return { allowed: true, remaining: remaining - emailsToSend, limit, sent };
}

async function incrementEmailCount(clientId, count = 1) {
  const redis = getAppRedis();
  if (!redis || !isRedisReady(redis) || count <= 0) return;
  const key = dailyLimitKey(clientId);
  try {
    await redisIncrBy(redis, key, count);
    await redis.expire(key, 86400 * 2);
  } catch (err) {
    log.warn('[incrementEmailCount] non-fatal:', err.message);
  }
}

async function getEmailDailyUsage(clientId) {
  const limit = getDailyLimit();
  const redis = getAppRedis();
  if (!redis || !isRedisReady(redis)) {
    return { sent: 0, limit, remaining: limit };
  }
  const sent = parseInt((await redis.get(dailyLimitKey(clientId))) || '0', 10) || 0;
  return { sent, limit, remaining: Math.max(0, limit - sent) };
}

module.exports = {
  checkEmailDailyLimit,
  incrementEmailCount,
  getEmailDailyUsage,
  getDailyLimit,
  redisIncrBy,
};
