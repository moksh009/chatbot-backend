'use strict';

/**
 * Structured dispatch observability — one JSON line per send-path outcome.
 * Grep-friendly: pm2 logs topedge-worker --nostream | grep '"event":'
 *
 * Always logs INFO for outcomes; set DISPATCH_EVENT_LOG=verbose for skip paths too.
 */

const createLogger = require('../core/logger');

const serviceLoggers = new Map();

function getLogger(service) {
  const key = String(service || 'Dispatch');
  if (!serviceLoggers.has(key)) {
    serviceLoggers.set(key, createLogger(key));
  }
  return serviceLoggers.get(key);
}

function isVerbose() {
  return process.env.DISPATCH_EVENT_LOG === 'verbose' || process.env.PERF_LOGGING === 'true';
}

/**
 * @param {string} service - Logger namespace (e.g. CampaignDispatch)
 * @param {string} event - Event name (e.g. campaign_message_sent)
 * @param {Record<string, unknown>} payload
 * @param {'info'|'warn'|'error'} [level]
 */
function logDispatchEvent(service, event, payload = {}, level = 'info') {
  const line = {
    event: String(event),
    ts: new Date().toISOString(),
    ...payload,
  };

  const log = getLogger(service);
  const outcome = String(payload.outcome || payload.status || '').toLowerCase();
  const isSkip = outcome === 'skipped' || outcome === 'skip' || payload.skipped === true;

  if (isSkip && !isVerbose()) return;

  if (level === 'error') {
    log.error(event, line);
  } else if (level === 'warn' || outcome === 'failed' || outcome === 'blocked') {
    log.warn(event, line);
  } else {
    log.info(event, line);
  }
}

module.exports = { logDispatchEvent };
