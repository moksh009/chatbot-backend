'use strict';

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
  await redis.incrBy(key, count);
  await redis.expire(key, 86400 * 2);
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
};
