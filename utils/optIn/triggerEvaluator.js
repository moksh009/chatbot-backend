'use strict';

/**
 * Shared opt-in trigger evaluation (Node-testable; mirrored in public/topedge-opt-in-triggers.js).
 */

const SHOPIFY_PAGE_TYPES = {
  home: (path) => path === '/' || path === '/index' || /^\/pages\/home\/?$/i.test(path),
  product: (path) => /\/products\//i.test(path),
  collection: (path) => /\/collections\//i.test(path),
  cart: (path) => /\/cart\/?$/i.test(path),
};

function normalizePath(path) {
  return String(path || '/').toLowerCase().split('?')[0];
}

function pathMatches(path, pattern) {
  if (!pattern || pattern === 'all') return true;
  const p = normalizePath(path);
  const pat = String(pattern).toLowerCase().trim();
  if (pat === 'all') return true;
  if (SHOPIFY_PAGE_TYPES[pat]) return SHOPIFY_PAGE_TYPES[pat](p);
  const needle = pat.replace(/^\//, '');
  return p.includes(needle);
}

function evaluatePageRules(where, path) {
  const w = where || {};
  const show = w.pagesToShow || ['all'];
  if (!show.includes('all') && !show.some((s) => pathMatches(path, s))) return false;
  const hide = w.pagesToHide || [];
  if (hide.some((h) => pathMatches(path, h))) return false;
  return true;
}

function evaluateDevice(devices, isMobile) {
  const list = devices || ['all'];
  if (list.includes('all')) return true;
  if (list.includes('mobile') && isMobile) return true;
  if (list.includes('desktop') && !isMobile) return true;
  return false;
}

function evaluateVisitor(who, ctx) {
  const vt = who?.visitorType || 'all';
  if (vt === 'all') return true;
  const isReturning = Boolean(ctx?.isReturningVisitor);
  const isSubscribed = Boolean(ctx?.isSubscribed);
  if (vt === 'new') return !isReturning;
  if (vt === 'returning') return isReturning;
  if (vt === 'not_subscribed') return !isSubscribed;
  return true;
}

function cooldownKey(toolId) {
  return `te_optin_cooldown_${toolId}`;
}

function readCooldown(storage, toolId) {
  if (!storage) return null;
  const raw = storage.getItem(cooldownKey(toolId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.at) return parsed;
  } catch (e) {
    if (raw === '1') return { at: Date.now(), legacy: true };
  }
  return null;
}

const WEEKDAY_TO_NUM = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function evaluateSchedule(schedule, now = Date.now()) {
  if (!schedule || !schedule.enabled) return true;

  const tz = schedule.timezone || 'Asia/Kolkata';
  const days = Array.isArray(schedule.days) ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  const startHour = Math.min(23, Math.max(0, Number(schedule.startHour) || 0));
  const endHour = Math.min(23, Math.max(0, Number(schedule.endHour) || 23));

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(now));

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const dayOfWeek = WEEKDAY_TO_NUM[weekday];

  if (dayOfWeek == null || Number.isNaN(hour)) return false;
  if (!days.includes(dayOfWeek)) return false;

  if (startHour <= endHour) {
    return hour >= startHour && hour <= endHour;
  }
  return hour >= startHour || hour <= endHour;
}

function evaluateFrequency(frequency, toolId, storage, sessionStorage, now = Date.now()) {
  const freq = frequency || {};
  const type = freq.type || 'once_per_session';
  const cooldownDays = Math.max(1, Number(freq.cooldownDays) || 3);
  const cooldownMs = cooldownDays * 86400000;
  const key = cooldownKey(toolId);
  const stored = readCooldown(storage, toolId);

  if (type === 'every_visit') {
    if (stored && now - stored.at < cooldownMs) return false;
    return true;
  }

  if (type === 'once_ever') {
    return !stored;
  }

  if (type === 'once_per_session') {
    if (sessionStorage && sessionStorage.getItem(key)) return false;
    return true;
  }

  if (type === 'once_per_day') {
    if (!stored) return true;
    if (cooldownDays > 1) return now - stored.at >= cooldownMs;
    const last = new Date(stored.at);
    const cur = new Date(now);
    return (
      last.getUTCFullYear() !== cur.getUTCFullYear() ||
      last.getUTCMonth() !== cur.getUTCMonth() ||
      last.getUTCDate() !== cur.getUTCDate()
    );
  }

  return true;
}

function passesTargetingRules(tool, ctx) {
  const tr = tool?.triggers || {};
  if (!evaluatePageRules(tr.where, ctx.path)) return false;
  if (!evaluateDevice(tr.where?.devices, ctx.isMobile)) return false;
  if (!evaluateVisitor(tr.who, ctx)) return false;
  if (!evaluateFrequency(tr.frequency, tool.id, ctx.storage, ctx.sessionStorage, ctx.now)) return false;
  if (!evaluateSchedule(tr.schedule, ctx.now)) return false;
  return true;
}

function normalizeCondition(when) {
  const c = when?.condition || 'delay';
  if (c === 'immediate_on_load' || c === 'immediate') return 'immediate';
  if (c === 'delay_seconds' || c === 'delay') return 'delay';
  return c;
}

function markToolShown(toolId, frequency, storage, sessionStorage) {
  const freq = frequency || {};
  const type = freq.type || 'once_per_session';
  const key = cooldownKey(toolId);
  const payload = JSON.stringify({ at: Date.now() });

  if (type === 'once_per_session' && sessionStorage) {
    sessionStorage.setItem(key, payload);
  }
  if (storage && (type === 'once_ever' || type === 'once_per_day' || type === 'every_visit')) {
    storage.setItem(key, payload);
  }
}

module.exports = {
  pathMatches,
  evaluatePageRules,
  evaluateDevice,
  evaluateVisitor,
  evaluateFrequency,
  evaluateSchedule,
  passesTargetingRules,
  normalizeCondition,
  markToolShown,
  cooldownKey,
  SHOPIFY_PAGE_TYPES,
};
