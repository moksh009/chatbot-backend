/** Defaults when channel block is missing (Module 1 / A11). */
const DEFAULT_CHANNEL_RATE_LIMITS = {
  whatsapp: { sustainedPerSec: 10, burst: 30 },
  email: { sustainedPerSec: 50, burst: 200 },
  instagram: { sustainedPerSec: 5, burst: 15 },
};

const THROTTLE_DURATION_MS = 5 * 60 * 1000;
const RESTORE_RAMP_FACTOR = 1.2;

function channelDefaults(channel) {
  return DEFAULT_CHANNEL_RATE_LIMITS[channel] || { sustainedPerSec: 10, burst: 30 };
}

/**
 * Normalize legacy flat shape → { configured, effective, throttledUntil, lastThrottleReason }.
 */
function normalizeChannelRateLimit(raw = {}, channel = 'whatsapp') {
  const defaults = channelDefaults(channel);
  const baseSustained = Number(raw.sustainedPerSec ?? defaults.sustainedPerSec);
  const baseBurst = Number(raw.burst ?? defaults.burst);

  let configured = raw.configured;
  let effective = raw.effective;
  if (!configured || typeof configured !== 'object') {
    configured = {
      sustainedPerSec: Number(configured?.sustainedPerSec ?? baseSustained),
      burst: Number(configured?.burst ?? baseBurst),
    };
  }
  if (!effective || typeof effective !== 'object') {
    effective = {
      sustainedPerSec: Number(effective?.sustainedPerSec ?? baseSustained),
      burst: Number(effective?.burst ?? baseBurst),
    };
  }

  return {
    configured: {
      sustainedPerSec: Math.max(1, Number(configured.sustainedPerSec || defaults.sustainedPerSec)),
      burst: Math.max(1, Number(configured.burst || defaults.burst)),
    },
    effective: {
      sustainedPerSec: Math.max(1, Number(effective.sustainedPerSec || configured.sustainedPerSec)),
      burst: Math.max(1, Number(effective.burst || configured.burst)),
    },
    throttledUntil: raw.throttledUntil ? new Date(raw.throttledUntil) : null,
    lastThrottleReason: raw.lastThrottleReason || null,
    lastThrottledAt: raw.lastThrottledAt ? new Date(raw.lastThrottledAt) : null,
  };
}

function halveEffective(effective) {
  return {
    sustainedPerSec: Math.max(1, Math.floor(Number(effective.sustainedPerSec) / 2)),
    burst: Math.max(3, Math.floor(Number(effective.burst) / 2)),
  };
}

function rampEffectiveTowardConfigured(effective, configured) {
  const next = {
    sustainedPerSec: Math.min(
      configured.sustainedPerSec,
      Math.max(1, Math.ceil(effective.sustainedPerSec * RESTORE_RAMP_FACTOR))
    ),
    burst: Math.min(
      configured.burst,
      Math.max(3, Math.ceil(effective.burst * RESTORE_RAMP_FACTOR))
    ),
  };
  const restored =
    next.sustainedPerSec >= configured.sustainedPerSec &&
    next.burst >= configured.burst;
  return { next, restored };
}

module.exports = {
  DEFAULT_CHANNEL_RATE_LIMITS,
  THROTTLE_DURATION_MS,
  RESTORE_RAMP_FACTOR,
  channelDefaults,
  normalizeChannelRateLimit,
  halveEffective,
  rampEffectiveTowardConfigured,
};
