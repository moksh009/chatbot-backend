/**
 * In-process latency samples for SLO measurement (P50/P95/P99).
 * Not a replacement for APM — enables cheap dashboards via /api/metrics/summary.
 */

const log = require('../utils/logger')('RequestMetrics');

const MAX_SAMPLES = 5000;
const durationsMs = [];
let errorCount = 0;
let totalCount = 0;

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.ceil((p / 100) * sortedArr.length) - 1));
  return sortedArr[idx];
}

function record(durationMs, statusCode) {
  totalCount += 1;
  if (statusCode >= 500) errorCount += 1;
  durationsMs.push(durationMs);
  if (durationsMs.length > MAX_SAMPLES) {
    durationsMs.splice(0, durationsMs.length - MAX_SAMPLES);
  }
}

function summarize() {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    samples: n,
    totalRequests: totalCount,
    errors5xx: errorCount,
    errorRateApprox: totalCount ? errorCount / totalCount : 0,
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
        record(Date.now() - start, res.statusCode);
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
  verifyMetricsSecret,
  record
};
