'use strict';

const moment = require('moment');

function normalizeDelayUnit(unit) {
  const raw = String(unit || 'm').toLowerCase().trim();
  if (raw === 'm' || raw === 'min' || raw === 'mins' || raw === 'minute' || raw === 'minutes') return 'm';
  if (raw === 'h' || raw === 'hr' || raw === 'hrs' || raw === 'hour' || raw === 'hours') return 'h';
  if (raw === 'd' || raw === 'day' || raw === 'days') return 'd';
  return 'm';
}

function normalizeDelayValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function momentUnitFromDelay(unit) {
  const u = normalizeDelayUnit(unit);
  if (u === 'h') return 'hours';
  if (u === 'd') return 'days';
  return 'minutes';
}

function delayValueToMs(value, unit) {
  const n = normalizeDelayValue(value);
  const u = normalizeDelayUnit(unit);
  if (u === 'h') return n * 3600000;
  if (u === 'd') return n * 86400000;
  return n * 60000;
}

/** Cumulative sendAt schedule — matches POST /sequences enrollment. */
function mapStepsWithCumulativeSendAt(steps = [], { start = new Date() } = {}) {
  let cursor = moment(start);
  return (steps || []).map((step) => {
    const normalizedUnit = normalizeDelayUnit(step.delayUnit);
    const normalizedValue = normalizeDelayValue(step.delayValue);
    cursor = cursor.add(normalizedValue, momentUnitFromDelay(normalizedUnit));
    return {
      ...step,
      delayValue: normalizedValue,
      delayUnit: normalizedUnit,
      sendAt: cursor.toDate(),
    };
  });
}

module.exports = {
  normalizeDelayUnit,
  normalizeDelayValue,
  momentUnitFromDelay,
  delayValueToMs,
  mapStepsWithCumulativeSendAt,
};
