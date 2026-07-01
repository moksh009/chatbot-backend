'use strict';

const log = require('../core/logger')('JourneyPipeline');

/**
 * Structured journey pipeline logs — grep backend for `[Journey]` to trace enroll → dispatch.
 *
 * Stages: trigger | enroll | compile | enqueue | dispatch | condition | send | complete | error
 */
function journeyLog(stage, message, meta = {}, level = 'info') {
  const payload = {
    stage,
    ...meta,
  };
  const line = `[Journey] ${stage}: ${message}`;
  if (level === 'warn') log.warn(line, payload);
  else if (level === 'error') log.error(line, payload);
  else log.info(line, payload);
}

function journeyLogError(stage, message, meta = {}) {
  journeyLog(stage, message, meta, 'error');
}

function journeyLogWarn(stage, message, meta = {}) {
  journeyLog(stage, message, meta, 'warn');
}

module.exports = {
  journeyLog,
  journeyLogError,
  journeyLogWarn,
};
