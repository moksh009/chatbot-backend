'use strict';

const NodeCache = require('node-cache');
const { dedupeAsync } = require('./requestDedupe');

const TTL_SEC = parseInt(process.env.BOOTSTRAP_CACHE_TTL_SEC || '45', 10) || 45;
const resultCache = new NodeCache({
  stdTTL: Math.max(15, TTL_SEC),
  checkperiod: 20,
  useClones: true,
});

/** In-flight dedupe + short TTL result cache for GET /auth/bootstrap. */
async function getBootstrapPayload(userId, { refresh = false }, fn) {
  const uid = String(userId || 'anon');
  const cacheKey = `auth:bootstrap:result:${uid}`;

  if (!refresh) {
    const hit = resultCache.get(cacheKey);
    if (hit) return hit;
  } else {
    resultCache.del(cacheKey);
  }

  const payload = await dedupeAsync(`auth:bootstrap:inflight:${uid}`, async () => {
    if (!refresh) {
      const hit = resultCache.get(cacheKey);
      if (hit) return hit;
    }
    const built = await fn();
    resultCache.set(cacheKey, built);
    return built;
  });

  return payload;
}

function invalidateBootstrapCache(userId) {
  if (!userId) return;
  resultCache.del(`auth:bootstrap:result:${String(userId)}`);
}

module.exports = { getBootstrapPayload, invalidateBootstrapCache };
