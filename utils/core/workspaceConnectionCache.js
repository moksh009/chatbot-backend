'use strict';

const { getAppRedis, isRedisReady } = require('./redisFactory');

/** Hot path — full merged payload (flags + probes + worker health). */
const FULL_CACHE_TTL_SEC = 30;
/** Stable integration flags + contract (no live probes / worker health). */
const FLAGS_CACHE_TTL_SEC = 300;

function fullCacheKey(clientId) {
  return `workspace:connection:${clientId}`;
}

function flagsCacheKey(clientId) {
  return `workspace:connection:flags:${clientId}`;
}

async function readJson(key) {
  const redis = getAppRedis();
  if (!redis || !isRedisReady(redis)) return null;
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(key, payload, ttlSec) {
  const redis = getAppRedis();
  if (!redis || !isRedisReady(redis)) return;
  try {
    await redis.setex(key, ttlSec, JSON.stringify(payload));
  } catch (err) {
    console.warn('[workspaceConnectionCache] write:', err.message);
  }
}

async function readFullCache(clientId) {
  return readJson(fullCacheKey(clientId));
}

async function readFlagsCache(clientId) {
  return readJson(flagsCacheKey(clientId));
}

async function writeFullCache(clientId, payload) {
  await writeJson(fullCacheKey(clientId), payload, FULL_CACHE_TTL_SEC);
}

async function writeFlagsCache(clientId, payload) {
  await writeJson(flagsCacheKey(clientId), payload, FLAGS_CACHE_TTL_SEC);
}

/** Bust both layers after connect/disconnect or explicit invalidate. */
async function invalidateWorkspaceConnectionCache(clientId) {
  const redis = getAppRedis();
  if (!redis || !isRedisReady(redis)) return;
  try {
    await Promise.all([
      redis.del(fullCacheKey(clientId)),
      redis.del(flagsCacheKey(clientId)),
    ]);
  } catch (err) {
    console.warn('[workspaceConnectionCache] invalidate:', err.message);
  }
}

/** Omit layers refreshed on every request (probes 30s, worker health). */
function stripVolatileConnectionLayers(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const { workerHealth, ...rest } = payload;
  return rest;
}

module.exports = {
  FULL_CACHE_TTL_SEC,
  FLAGS_CACHE_TTL_SEC,
  fullCacheKey,
  flagsCacheKey,
  readFullCache,
  readFlagsCache,
  writeFullCache,
  writeFlagsCache,
  invalidateWorkspaceConnectionCache,
  stripVolatileConnectionLayers,
};
