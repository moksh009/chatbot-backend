'use strict';

/**
 * Single source of truth for cart recovery timing, smart send, and tier thresholds.
 * Import here — do not duplicate 15/25/30 min literals elsewhere.
 */

/** Option B: active → abandoned promotion vs first message delay are separate. */
const CART_RECOVERY_DEFAULTS = {
  promotionDelayMinutes: 10,
  step1DelayMinutes: 25,
  step2DelayMinutes: 4 * 60,
  step3DelayMinutes: 36 * 60,
  smartSendEnabled: true,
  smartSendStartHour: 8,
  smartSendEndHour: 22,
  timezone: 'Asia/Kolkata',
  /** Orders on same phone within this window after any cart WA message → WhatsApp recovery */
  attributionWindowHours: 7 * 24,
  /** 50/50 template A/B per step when variant B configured on rule (Phase 7) */
  abTestEnabled: false,
};

/** Minimum delay merchants may configure (minutes from cart abandoned). */
const CART_FOLLOWUP_MIN_MINUTES = {
  followup_1: 15,
  followup_2: 2 * 60,
  followup_3: 24 * 60,
};

/** Default rule delays — aligned with cron + SAC UI. */
const CART_FOLLOWUP_DEFAULT_MINUTES = {
  followup_1: CART_RECOVERY_DEFAULTS.step1DelayMinutes,
  followup_2: CART_RECOVERY_DEFAULTS.step2DelayMinutes,
  followup_3: CART_RECOVERY_DEFAULTS.step3DelayMinutes,
};

/** India D2C cart value tiers (₹). */
const CART_VALUE_TIER_THRESHOLDS = {
  high: 5000,
  medium: 1500,
};

const CART_VALUE_TIER_RANK = { high: 3, medium: 2, low: 1 };

/** Estimated recovery probability by last message step (NEW-2). */
const CART_RECOVERY_STEP_PROBABILITIES = {
  0: 0.05,
  1: 0.12,
  2: 0.18,
  3: 0.25,
};

function resolveCartNudgeDelay(value, fallback) {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function clampDelayMinutes(value, min, fallback) {
  const n = resolveCartNudgeDelay(value, fallback);
  return Math.max(min, Math.min(1440 * 14, Math.round(n)));
}

/** Legacy platform default before 7-day cart ladder attribution (June 2026). */
const LEGACY_ATTRIBUTION_WINDOW_HOURS = 24;

/**
 * Resolve WA recovery attribution window (hours).
 * Priority: per-tenant config (if not legacy 24) → env → 7-day default.
 */
function resolveAttributionWindowHours(clientHours) {
  const envRaw = process.env.CART_RECOVERY_ATTRIBUTION_HOURS;
  if (envRaw != null && String(envRaw).trim() !== '') {
    const envHours = Number(envRaw);
    if (Number.isFinite(envHours) && envHours > 0) return envHours;
  }

  const stored = clientHours != null ? Number(clientHours) : null;
  if (
    stored != null &&
    Number.isFinite(stored) &&
    stored > 0 &&
    stored !== LEGACY_ATTRIBUTION_WINDOW_HOURS
  ) {
    return stored;
  }

  return CART_RECOVERY_DEFAULTS.attributionWindowHours;
}

function attributionWindowMsFromHours(hours) {
  return Math.max(1, Number(hours) || CART_RECOVERY_DEFAULTS.attributionWindowHours) * 60 * 60 * 1000;
}

module.exports = {
  CART_RECOVERY_DEFAULTS,
  CART_FOLLOWUP_MIN_MINUTES,
  CART_FOLLOWUP_DEFAULT_MINUTES,
  CART_VALUE_TIER_THRESHOLDS,
  CART_VALUE_TIER_RANK,
  CART_RECOVERY_STEP_PROBABILITIES,
  LEGACY_ATTRIBUTION_WINDOW_HOURS,
  resolveCartNudgeDelay,
  clampDelayMinutes,
  resolveAttributionWindowHours,
  attributionWindowMsFromHours,
};
