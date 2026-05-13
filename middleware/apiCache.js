const NodeCache = require('node-cache');
const log = require('../utils/logger')('ApiCache');
const { getAppRedis } = require('../utils/redisFactory');

const memoryCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

/** Lazily resolve Redis — same singleton as locks / dedupe (not a second connection). */
function getRedisForCache() {
  return getAppRedis();
}

/**
 * Delete keys matching a pattern without Redis KEYS (KEYS blocks the server O(N)).
 * Uses SCAN + batched DEL — safe under load for large keyspaces.
 */
async function redisDeleteByPattern(redisClient, pattern) {
  let cursor = '0';
  let deleted = 0;
  do {
    const [nextCursor, keys] = await redisClient.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      400
    );
    cursor = String(nextCursor);
    if (keys && keys.length) {
      await redisClient.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== '0');
  return deleted;
}

/**
 * Express middleware to cache API responses
 * @param {number} ttlSeconds Time to live in seconds
 */
const apiCache = (ttlSeconds = 60) => {
  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return next();
    }

    const clientId = req.user?.clientId || req.params?.clientId || 'public';
    const route = req.originalUrl || req.url;

    let cacheKey = `api_cache:${clientId}:${route}`;
    if (req.method === 'POST') {
      const crypto = require('crypto');
      const bodyHash = crypto.createHash('md5').update(JSON.stringify(req.body || {})).digest('hex');
      cacheKey = `${cacheKey}:${bodyHash}`;
    }

    const redisClient = getRedisForCache();

    try {
      if (redisClient) {
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          return res.setHeader('X-Cache', 'HIT-REDIS').json(JSON.parse(cachedData));
        }
      } else {
        const cachedData = memoryCache.get(cacheKey);
        if (cachedData) {
          return res.setHeader('X-Cache', 'HIT-MEMORY').json(cachedData);
        }
      }
    } catch (error) {
      log.error(`[ApiCache] Cache read error for ${cacheKey}:`, error.message);
    }

    const originalJson = res.json;
    res.json = function (body) {
      try {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const rc = getRedisForCache();
          if (rc) {
            rc.setex(cacheKey, ttlSeconds, JSON.stringify(body)).catch((err) =>
              log.error(`[ApiCache] Redis write error for ${cacheKey}:`, err.message)
            );
          } else {
            memoryCache.set(cacheKey, body, ttlSeconds);
          }
        }
      } catch (error) {
        log.error(`[ApiCache] Cache write error for ${cacheKey}:`, error.message);
      }

      res.setHeader('X-Cache', 'MISS');

      return originalJson.call(this, body);
    };

    next();
  };
};

/**
 * Clear cache for a specific client (e.g. on settings update)
 * @param {string} clientId
 */
const clearClientCache = async (clientId) => {
  try {
    const redisClient = getRedisForCache();
    if (redisClient) {
      await redisDeleteByPattern(redisClient, `api_cache:${clientId}:*`);
    } else {
      const keys = memoryCache.keys().filter((k) => k.startsWith(`api_cache:${clientId}:`));
      keys.forEach((k) => memoryCache.del(k));
    }
  } catch (error) {
    log.error(`[ApiCache] Failed to clear cache for ${clientId}:`, error.message);
  }
};

module.exports = { apiCache, clearClientCache };
