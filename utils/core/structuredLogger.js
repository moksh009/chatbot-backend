'use strict';

/**
 * Pino-backed structured logger (Phase 9). Falls back to legacy logger when disabled.
 */
let pino;
try {
  pino = require('pino');
} catch {
  pino = null;
}

const usePino =
  pino &&
  (process.env.LOG_STRUCTURED === 'true' || process.env.NODE_ENV === 'production');

const root = usePino
  ? pino({
      level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
      ...(process.env.NODE_ENV !== 'production' && !process.env.LOG_STRUCTURED
        ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
        : {}),
    })
  : null;

function createLogger(service) {
  if (!root) {
    return require('./logger')(service);
  }
  const child = root.child({ service });
  return {
    info: (msg, data) => child.info(data || {}, msg),
    warn: (msg, data) => child.warn(data || {}, msg),
    error: (msg, data) => child.error(data || {}, msg),
    debug: (msg, data) => child.debug(data || {}, msg),
    success: (msg, data) => child.info(data || {}, msg),
  };
}

module.exports = createLogger;
