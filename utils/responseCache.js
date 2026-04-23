/**
 * utils/responseCache.js
 * In-memory LRU caching middleware for heavy endpoints.
 */
const NodeCache = require('node-cache');
// Standard TTL is 5 minutes
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

const responseCache = (ttlSeconds = 300) => {
    return (req, res, next) => {
        // Create a unique key based on URL and query params
        // Also scope by clientId/user to prevent cross-tenant data leaks
        const key = `__express__${req.originalUrl || req.url}__user_${req.user?._id || 'public'}__client_${req.params.clientId || req.query.clientId || 'none'}`;
        
        const cachedBody = cache.get(key);
        if (cachedBody) {
            return res.json(cachedBody);
        } else {
            res.sendResponse = res.json;
            res.json = (body) => {
                cache.set(key, body, ttlSeconds);
                res.sendResponse(body);
            };
            next();
        }
    };
};

module.exports = { responseCache, cache };
