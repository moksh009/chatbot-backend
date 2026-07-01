'use strict';

/**
 * In-process cache for calculateRecoveryMetrics (Phase 4.3).
 * Shared across dashboard workspace, analytics workspace, /cart-recovery/metrics, etc.
 */

const recoveryMetricsMemCache = new Map();
/** In-flight dedupe — parallel dashboard widgets share one compute. */
const recoveryMetricsInflight = new Map();

/** Cohort dashboard metrics — align with dashboard workspace apiCache(60). */
const RECOVERY_METRICS_CACHE_TTL_MS = 90_000;

function buildRecoveryMetricsCacheKey(clientId, options, resolvedRange) {
  const mode = options.mode === 'activity' ? 'activity' : 'cohort';
  const includeFunnel = options.includeFunnel !== false ? '1' : '0';
  const includeRows = options.includeRows === true ? '1' : '0';
  const includeChartBuckets = options.includeChartBuckets === true ? '1' : '0';
  const chartBucketUnit = options.chartBucketUnit || 'day';
  const from = resolvedRange?.from instanceof Date ? resolvedRange.from.toISOString() : '';
  const to = resolvedRange?.to instanceof Date ? resolvedRange.to.toISOString() : '';
  const timezone = resolvedRange?.timezone || 'Asia/Kolkata';
  return `${clientId}:${mode}:${from}:${to}:${timezone}:${includeFunnel}:${includeRows}:${includeChartBuckets}:${chartBucketUnit}`;
}

/**
 * Coalesce concurrent calculateRecoveryMetrics calls with the same cache key.
 */
async function dedupeRecoveryMetricsCompute(cacheKey, compute) {
  const existing = recoveryMetricsInflight.get(cacheKey);
  if (existing) return existing;

  const promise = Promise.resolve()
    .then(compute)
    .finally(() => {
      if (recoveryMetricsInflight.get(cacheKey) === promise) {
        recoveryMetricsInflight.delete(cacheKey);
      }
    });
  recoveryMetricsInflight.set(cacheKey, promise);
  return promise;
}

function readRecoveryMetricsCache(key) {
  const row = recoveryMetricsMemCache.get(key);
  if (!row || row.exp < Date.now()) {
    if (row) recoveryMetricsMemCache.delete(key);
    return null;
  }
  return row.body;
}

function writeRecoveryMetricsCache(key, body, ttlMs = RECOVERY_METRICS_CACHE_TTL_MS) {
  const ttl = Number(ttlMs) > 0 ? ttlMs : RECOVERY_METRICS_CACHE_TTL_MS;
  recoveryMetricsMemCache.set(key, { exp: Date.now() + ttl, body });
}

function invalidateRecoveryMetricsCache(clientId) {
  if (!clientId) {
    recoveryMetricsMemCache.clear();
    return;
  }
  const prefix = `${clientId}:`;
  for (const key of recoveryMetricsMemCache.keys()) {
    if (key.startsWith(prefix)) {
      recoveryMetricsMemCache.delete(key);
    }
  }
}

function shouldBypassRecoveryMetricsCache(options = {}) {
  if (options.bypassCache === true || options.skipCache === true) return true;
  // Row-level exports can be large — always compute fresh.
  if (options.includeRows === true) return true;
  return false;
}

module.exports = {
  RECOVERY_METRICS_CACHE_TTL_MS,
  buildRecoveryMetricsCacheKey,
  readRecoveryMetricsCache,
  writeRecoveryMetricsCache,
  invalidateRecoveryMetricsCache,
  shouldBypassRecoveryMetricsCache,
  dedupeRecoveryMetricsCompute,
};
