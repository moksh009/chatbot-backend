/**
 * Server-Side Cache Utility
 * Different TTLs for different data types to balance freshness vs performance.
 */
const NodeCache = require("node-cache");

const cache = {
  stats:     new NodeCache({ stdTTL: 30,    checkperiod: 60,    useClones: false }), // 30s — changes often
  insights:  new NodeCache({ stdTTL: 86400, checkperiod: 3600,  useClones: false }), // 24h — expensive to generate
  templates: new NodeCache({ stdTTL: 300,   checkperiod: 60,    useClones: false }), // 5m  — Meta API calls
  products:  new NodeCache({ stdTTL: 3600,  checkperiod: 600,   useClones: false }), // 1h  — Shopify catalog
  cohort:    new NodeCache({ stdTTL: 3600,  checkperiod: 600,   useClones: false }), // 1h  — heavy aggregation
  batch:     new NodeCache({ stdTTL: 20,    checkperiod: 30,    useClones: false }), // 20s — batch page data
};

/**
 * Build a namespaced cache key.
 * @param {string} type - Cache store name (e.g. "stats", "batch")
 * @param {string} clientId
 * @param {string} [extra] - Optional suffix (e.g. period, page)
 */
function getCacheKey(type, clientId, extra = "") {
  return `${type}:${clientId}${extra ? ":" + extra : ""}`;
}

/**
 * Get a cached value or compute + store it.
 * @param {NodeCache} cacheStore
 * @param {string} key
 * @param {Function} computeFn - Async function that returns the value
 * @returns {Promise<any>}
 */
async function getOrCompute(cacheStore, key, computeFn) {
  const cached = cacheStore.get(key);
  if (cached !== undefined) return cached;

  const result = await computeFn();
  cacheStore.set(key, result);
  return result;
}

/**
 * Invalidate a specific cache entry.
 * @param {string} type - Cache store name
 * @param {string} clientId
 * @param {string} [extra]
 */
function invalidate(type, clientId, extra = "") {
  const key = getCacheKey(type, clientId, extra);
  if (cache[type]) {
    cache[type].del(key);
  }
}

/**
 * Invalidate all cache entries for a given clientId across all stores.
 * Call this after significant data mutations (e.g. order placed, new message).
 * @param {string} clientId
 */
function invalidateAll(clientId) {
  Object.keys(cache).forEach((type) => {
    // Node-cache doesn't support pattern delete, so we track common keys
    ["", "month", "week", "day", "year"].forEach((period) => {
      const key = getCacheKey(type, clientId, period);
      cache[type].del(key);
    });
  });
}

module.exports = { cache, getCacheKey, getOrCompute, invalidate, invalidateAll };
