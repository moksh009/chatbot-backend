const NodeCache = require('node-cache');
const log = require('../utils/logger')('ApiCache');
const { getAppRedis } = require('../utils/redisFactory');

const memoryCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

/** Lazily resolve Redis — same singleton as locks / dedupe (not a second connection). */
function getRedisForCache() {
  return getAppRedis();
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
      const keys = await redisClient.keys(`api_cache:${clientId}:*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } else {
      const keys = memoryCache.keys().filter((k) => k.startsWith(`api_cache:${clientId}:`));
      keys.forEach((k) => memoryCache.del(k));
    }
  } catch (error) {
    log.error(`[ApiCache] Failed to clear cache for ${clientId}:`, error.message);
  }
};

module.exports = { apiCache, clearClientCache };
