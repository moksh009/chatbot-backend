'use strict';

const { CART_RECOVERY_DEFAULTS } = require('../../constants/cartRecoveryDefaults');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toIstParts(date, timezone = CART_RECOVERY_DEFAULTS.timezone) {
  if (timezone !== 'Asia/Kolkata') {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value || 0);
    return { hour, minute };
  }
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return { hour: ist.getUTCHours(), minute: ist.getUTCMinutes() };
}

function computeNextAllowedSendAt(fromDate, config = {}) {
  const enabled = config.smartSendEnabled !== false;
  if (!enabled) return null;

  const startHour = Number(config.smartSendStartHour ?? CART_RECOVERY_DEFAULTS.smartSendStartHour);
  const endHour = Number(config.smartSendEndHour ?? CART_RECOVERY_DEFAULTS.smartSendEndHour);
  const timezone = config.timezone || CART_RECOVERY_DEFAULTS.timezone;
  const now = fromDate instanceof Date ? fromDate : new Date(fromDate || Date.now());
  const { hour } = toIstParts(now, timezone);

  if (hour >= startHour && hour < endHour) return null;

  const target = new Date(now);
  if (timezone === 'Asia/Kolkata') {
    const istNow = new Date(now.getTime() + IST_OFFSET_MS);
    if (hour >= endHour) {
      istNow.setUTCDate(istNow.getUTCDate() + 1);
    }
    istNow.setUTCHours(startHour, 0, 0, 0);
    return new Date(istNow.getTime() - IST_OFFSET_MS);
  }

  const fmtDay = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayStr = fmtDay.format(now);
  let candidate = new Date(`${dayStr}T${String(startHour).padStart(2, '0')}:00:00`);
  if (hour >= endHour) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  if (candidate <= now) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

function isWithinSmartSendWindow(date, config = {}) {
  const enabled = config.smartSendEnabled !== false;
  if (!enabled) return true;

  const startHour = Number(config.smartSendStartHour ?? CART_RECOVERY_DEFAULTS.smartSendStartHour);
  const endHour = Number(config.smartSendEndHour ?? CART_RECOVERY_DEFAULTS.smartSendEndHour);
  const timezone = config.timezone || CART_RECOVERY_DEFAULTS.timezone;
  const { hour } = toIstParts(date instanceof Date ? date : new Date(date || Date.now()), timezone);
  return hour >= startHour && hour < endHour;
}

function evaluateSmartSendWindow(date, config = {}) {
  const now = date instanceof Date ? date : new Date(date || Date.now());
  if (isWithinSmartSendWindow(now, config)) {
    return { allowed: true, nextAllowedSendAt: null };
  }
  return {
    allowed: false,
    nextAllowedSendAt: computeNextAllowedSendAt(now, config),
  };
}

module.exports = {
  computeNextAllowedSendAt,
  isWithinSmartSendWindow,
  evaluateSmartSendWindow,
};
