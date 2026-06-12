/**
 * In-process latency samples for SLO measurement (P50/P95/P99).
 * Not a replacement for APM — enables cheap dashboards via /api/metrics/summary.
 */

const log = require('../utils/core/logger')('RequestMetrics');

const MAX_SAMPLES = 5000;
const MAX_BUCKETS = 336; // ~7d at 30-min resolution
const durationsMs = [];
let errorCount = 0;
let error4xxCount = 0;
let totalCount = 0;

/** @type {Map<number, { requests: number, errors5xx: number, errors4xx: number, latencySum: number, latencyCount: number }>} */
const timeBuckets = new Map();

const RANGE_CONFIG = {
  '1h': { ms: 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 },
  '6h': { ms: 6 * 60 * 60 * 1000, bucketMs: 30 * 60 * 1000 },
  '24h': { ms: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 },
  '7d': { ms: 7 * 24 * 60 * 60 * 1000, bucketMs: 6 * 60 * 60 * 1000 },
};

function bucketKey(ts, bucketMs) {
  return Math.floor(ts / bucketMs) * bucketMs;
}

function touchBucket(ts, durationMs, statusCode) {
  const bucketMs = 5 * 60 * 1000;
  const key = bucketKey(ts, bucketMs);
  const row = timeBuckets.get(key) || {
    requests: 0,
    errors5xx: 0,
    errors4xx: 0,
    latencySum: 0,
    latencyCount: 0,
  };
  row.requests += 1;
  if (statusCode >= 500) row.errors5xx += 1;
  if (statusCode >= 400 && statusCode < 500) row.errors4xx += 1;
  row.latencySum += durationMs;
  row.latencyCount += 1;
  timeBuckets.set(key, row);

  if (timeBuckets.size > MAX_BUCKETS) {
    const oldest = Math.min(...timeBuckets.keys());
    timeBuckets.delete(oldest);
  }
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1));
  return sortedArr[idx];
}

function record(durationMs, statusCode) {
  totalCount += 1;
  if (statusCode >= 500) errorCount += 1;
  if (statusCode >= 400 && statusCode < 500) error4xxCount += 1;
  durationsMs.push(durationMs);
  if (durationsMs.length > MAX_SAMPLES) {
    durationsMs.splice(0, durationsMs.length - MAX_SAMPLES);
  }
  touchBucket(Date.now(), durationMs, statusCode);
}

function getTimeseries(range = '24h') {
  const cfg = RANGE_CONFIG[range] || RANGE_CONFIG['24h'];
  const now = Date.now();
  const since = now - cfg.ms;
  const points = [];

  for (let t = bucketKey(since, cfg.bucketMs); t <= now; t += cfg.bucketMs) {
    let requests = 0;
    let errors5xx = 0;
    let errors4xx = 0;
    let latencySum = 0;
    let latencyCount = 0;

    const subBucketMs = 5 * 60 * 1000;
    for (let sub = t; sub < t + cfg.bucketMs; sub += subBucketMs) {
      const row = timeBuckets.get(sub);
      if (!row) continue;
      requests += row.requests;
      errors5xx += row.errors5xx;
      errors4xx += row.errors4xx;
      latencySum += row.latencySum;
      latencyCount += row.latencyCount;
    }

    points.push({
      ts: new Date(t).toISOString(),
      requests,
      errors5xx,
      errors4xx,
      errors: errors5xx + errors4xx,
      p95Ms: latencyCount ? Math.round(latencySum / latencyCount) : 0,
    });
  }

  return { range, bucketMs: cfg.bucketMs, points };
}

function summarize() {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    samples: n,
    totalRequests: totalCount,
    errors5xx: errorCount,
    errors4xx: error4xxCount,
    errorRateApprox: totalCount ? errorCount / totalCount : 0,
    errorRate5xxPct: totalCount ? ((errorCount / totalCount) * 100).toFixed(1) : '0.0',
    latencyMs: {
      p50: percentile(sorted, 50),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: n ? sorted[n - 1] : 0
    },
    sloHint: {
      targetP95MsAuthApi: Number(process.env.SLO_P95_MS_AUTH_API) || 500,
      note: 'Tune SLO_P95_MS_AUTH_API to your contract; compare p95 above.'
    }
  };
}

function middleware() {
  return (req, res, next) => {
    const path = req.originalUrl.split('?')[0];
    if (path === '/api/health' || path.startsWith('/api/metrics/')) {
      return next();
    }
    const start = Date.now();
    res.on('finish', () => {
      try {
        const durationMs = Date.now() - start;
        record(durationMs, res.statusCode);
        const slowMs = Number(process.env.SLOW_REQUEST_MS || 5000);
        if (durationMs >= slowMs) {
          const clientId =
            req.user?.clientId || req.params?.clientId || req.query?.clientId || 'unknown';
          log.warn(
            `[SlowRequest] ${req.method} ${path} ${durationMs}ms status=${res.statusCode} clientId=${clientId}`
          );
        }
      } catch (e) {
        log.warn('requestMetrics finish error', e.message);
      }
    });
    next();
  };
}

function verifyMetricsSecret(req) {
  const secret = process.env.METRICS_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  const hdr = req.headers['x-metrics-secret'];
  return hdr === secret;
}

module.exports = {
  middleware,
  summarize,
  getTimeseries,
  verifyMetricsSecret,
  record,
  RANGE_CONFIG,
};
