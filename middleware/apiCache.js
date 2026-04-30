const Redis = require('ioredis');
const NodeCache = require('node-cache');
const log = require('../utils/logger')('ApiCache');

// Fallback memory cache (TTL in seconds)
const memoryCache = new NodeCache({ stdTTL: 60, checkperiod: 120 });

// Attempt to use existing Redis connection from env
let redisClient = null;
if (process.env.REDIS_URL && !process.env.REDIS_URL.includes('red-')) {
    // Exclude internal render red- hostnames if running locally, same logic as queues
    redisClient = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        retryStrategy: (times) => Math.min(times * 100, 3000)
    });

    redisClient.on('error', (err) => {
        log.warn('[ApiCache] Redis error, falling back to memory cache.');
        redisClient = null;
    });
    
    redisClient.on('connect', () => {
        log.info('[ApiCache] Connected to Redis successfully.');
    });
}

/**
 * Express middleware to cache API responses
 * @param {number} ttlSeconds Time to live in seconds
 */
const apiCache = (ttlSeconds = 60) => {
    return async (req, res, next) => {
        // Only cache GET or POST
        if (req.method !== 'GET' && req.method !== 'POST') {
            return next();
        }

        // Generate cache key based on route, query params, and clientId (if authenticated)
        const clientId = req.user?.clientId || req.params?.clientId || 'public';
        const route = req.originalUrl || req.url;
        
        let cacheKey = `api_cache:${clientId}:${route}`;
        if (req.method === 'POST') {
            const crypto = require('crypto');
            const bodyHash = crypto.createHash('md5').update(JSON.stringify(req.body || {})).digest('hex');
            cacheKey = `${cacheKey}:${bodyHash}`;
        }

        try {
            // Try fetching from Redis first
            if (redisClient && redisClient.status === 'ready') {
                const cachedData = await redisClient.get(cacheKey);
                if (cachedData) {
                    return res.setHeader('X-Cache', 'HIT-REDIS').json(JSON.parse(cachedData));
                }
            } else {
                // Try memory cache
                const cachedData = memoryCache.get(cacheKey);
                if (cachedData) {
                    return res.setHeader('X-Cache', 'HIT-MEMORY').json(cachedData);
                }
            }
        } catch (error) {
            log.error(`[ApiCache] Cache read error for ${cacheKey}:`, error.message);
        }

        // Intercept res.json to cache the response before sending it
        const originalJson = res.json;
        res.json = function (body) {
            try {
                // Do not cache error responses
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    if (redisClient && redisClient.status === 'ready') {
                        redisClient.setex(cacheKey, ttlSeconds, JSON.stringify(body)).catch(err => 
                            log.error(`[ApiCache] Redis write error for ${cacheKey}:`, err.message)
                        );
                    } else {
                        memoryCache.set(cacheKey, body, ttlSeconds);
                    }
                }
            } catch (error) {
                log.error(`[ApiCache] Cache write error for ${cacheKey}:`, error.message);
            }
            
            // Add miss header
            res.setHeader('X-Cache', 'MISS');
            
            // Call original json method
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
        if (redisClient && redisClient.status === 'ready') {
            const keys = await redisClient.keys(`api_cache:${clientId}:*`);
            if (keys.length > 0) {
                await redisClient.del(keys);
            }
        } else {
            const keys = memoryCache.keys().filter(k => k.startsWith(`api_cache:${clientId}:`));
            keys.forEach(k => memoryCache.del(k));
        }
    } catch (error) {
        log.error(`[ApiCache] Failed to clear cache for ${clientId}:`, error.message);
    }
};

module.exports = { apiCache, clearClientCache };
