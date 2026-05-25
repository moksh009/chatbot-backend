const { getAppRedis } = require('../../core/redisFactory');
const { resolveMaxParallel } = require('./planConcurrency');

function concurrencyKey(clientId, channel) {
  return `concurrency:${clientId}:${channel}`;
}

async function acquire({ client, clientId, channel }) {
  const cid = clientId || client?.clientId;
  const ch = channel || 'whatsapp';
  const redis = getAppRedis();
  const max = resolveMaxParallel(client, ch);
  if (!redis) return { acquired: true };

  const key = concurrencyKey(cid, ch);
  const count = await redis.incr(key);
  await redis.expire(key, 60);
  if (count > max) {
    await redis.decr(key);
    const retryAfter = 1 + Math.floor(Math.random() * 2);
    return { acquired: false, retryAfter };
  }
  return { acquired: true };
}

async function release({ clientId, channel }) {
  const redis = getAppRedis();
  if (!redis || !clientId) return;
  const key = concurrencyKey(clientId, channel);
  const n = await redis.decr(key);
  if (n < 0) await redis.set(key, '0', 'EX', 60);
}

module.exports = { acquire, release, concurrencyKey, resolveMaxParallel };
