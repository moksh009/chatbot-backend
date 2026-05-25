const Client = require('../../models/Client');
const { getAppRedis } = require('../core/redisFactory');
const log = require('../core/logger')('ChannelRateLimits');
const {
  DEFAULT_CHANNEL_RATE_LIMITS,
  THROTTLE_DURATION_MS,
  normalizeChannelRateLimit,
  halveEffective,
  rampEffectiveTowardConfigured,
} = require('./rateLimitConfig');

const CHANNELS = ['whatsapp', 'email', 'instagram'];
const RECENT_429_KEY = (clientId, channel) => `envelope:rl:429:${clientId}:${channel}`;

function getChannelBlock(client, channel) {
  const raw = client?.complianceConfig?.rateLimits?.[channel] || {};
  return normalizeChannelRateLimit(raw, channel);
}

/** Token bucket reads effective limits only (A11). */
async function resolveChannelRateLimits(client, channel) {
  const block = getChannelBlock(client, channel);
  return { sustainedPerSec: block.effective.sustainedPerSec, burst: block.effective.burst };
}

async function applyRateLimitThrottle(clientId, channel, reason = 'meta_429') {
  const client = await Client.findOne({ clientId }).select('complianceConfig').lean();
  if (!client) return;

  const block = getChannelBlock(client, channel);
  const effective = halveEffective(block.effective);
  const throttledUntil = new Date(Date.now() + THROTTLE_DURATION_MS);
  const throttleReason = String(reason || 'meta_429');

  const path = `complianceConfig.rateLimits.${channel}`;
  await Client.updateOne(
    { clientId },
    {
      $set: {
        [`${path}.configured`]: block.configured,
        [`${path}.effective`]: effective,
        [`${path}.throttledUntil`]: throttledUntil,
        [`${path}.lastThrottleReason`]: throttleReason,
        [`${path}.lastThrottledAt`]: new Date(),
      },
    }
  ).catch((err) => log.warn(`Persist throttle failed: ${err.message}`));

  const redis = getAppRedis();
  if (redis) {
    await redis.set(RECENT_429_KEY(clientId, channel), '1', 'EX', 120).catch(() => {});
  }
}

/**
 * Maintenance tick: ramp effective toward configured when throttle window elapsed (A11).
 */
async function tickRateLimitRestore() {
  const clients = await Client.find({
    'complianceConfig.rateLimits': { $exists: true },
  })
    .select('clientId complianceConfig')
    .lean();

  const redis = getAppRedis();
  const now = Date.now();
  let restored = 0;

  for (const client of clients) {
    for (const channel of CHANNELS) {
      const block = getChannelBlock(client, channel);
      if (!block.throttledUntil || block.throttledUntil.getTime() > now) continue;

      if (redis) {
        const recent = await redis.get(RECENT_429_KEY(client.clientId, channel));
        if (recent) continue;
      }

      const { next, restored: atConfigured } = rampEffectiveTowardConfigured(
        block.effective,
        block.configured
      );
      const path = `complianceConfig.rateLimits.${channel}`;
      const $set = {
        [`${path}.configured`]: block.configured,
        [`${path}.effective`]: next,
      };
      if (atConfigured) {
        $set[`${path}.throttledUntil`] = null;
        $set[`${path}.lastThrottleReason`] = null;
      }
      await Client.updateOne({ clientId: client.clientId }, { $set });
      restored += 1;
    }
  }
  return { restored };
}

function isRateLimitError(err) {
  const status = err?.status || err?.response?.status;
  if (status === 429) return true;
  const code = Number(err?.data?.code || err?.response?.data?.error?.code || 0);
  const msg = String(err?.message || '').toLowerCase();
  return code === 429 || code === 130429 || msg.includes('rate limit') || msg.includes('too many');
}

module.exports = {
  DEFAULT_CHANNEL_RATE_LIMITS,
  resolveChannelRateLimits,
  applyRateLimitThrottle,
  tickRateLimitRestore,
  isRateLimitError,
  getChannelBlock,
  normalizeChannelRateLimit,
};
