'use strict';

const log = require('../utils/core/logger')('SlowRequest');

const DEFAULT_THRESHOLD_MS = 2000;

function isEnabled() {
  if (process.env.SLOW_REQUEST_LOG === 'false') return false;
  if (process.env.SLOW_REQUEST_LOG === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

/**
 * Logs API requests slower than threshold (default 2s).
 * Enabled in non-production unless SLOW_REQUEST_LOG=false.
 */
function slowRequestLogger(thresholdMs = DEFAULT_THRESHOLD_MS) {
  const threshold = Number(thresholdMs) > 0 ? Number(thresholdMs) : DEFAULT_THRESHOLD_MS;

  return (req, res, next) => {
    if (!isEnabled()) return next();
    const path = req.originalUrl || req.url || '';
    if (!path.startsWith('/api/')) return next();

    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      if (ms < threshold) return;
      log.warn(`${req.method} ${path} → ${res.statusCode} in ${ms}ms`, {
        ms,
        status: res.statusCode,
      });
    });
    next();
  };
}

module.exports = slowRequestLogger;
