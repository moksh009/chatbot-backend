'use strict';

const { getAppRedis } = require('../core/redisFactory');

const CRON_KEY = 'cron:last_tick';
const STALE_MS = 10 * 60 * 1000;

/**
 * Merchant-visible worker / cron health (Phase 2).
 */
async function buildPlatformHealth() {
  const redis = getAppRedis();
  let workersOk = false;
  let redisOk = false;
  let lastCronAt = null;
  let lastCronAgeMs = null;

  if (redis && redis.status === 'ready') {
    redisOk = true;
    try {
      const last = await redis.get(CRON_KEY);
      if (last) {
        lastCronAt = new Date(Number(last)).toISOString();
        lastCronAgeMs = Date.now() - Number(last);
        workersOk = lastCronAgeMs <= STALE_MS;
      }
    } catch {
      workersOk = false;
    }
  }

  const runCrons =
    process.env.CRON_WORKER === 'true' ||
    (process.env.CRON_WORKER !== 'false' && process.env.RUN_CRONS !== 'false');

  return {
    workersOk,
    redisOk,
    cronWorkerEnabled: runCrons,
    lastCronAt,
    lastCronAgeMs,
    automationsLabel: workersOk ? 'Running' : runCrons ? 'Delayed' : 'Paused (dev)',
    automationsStatus: workersOk ? 'ok' : runCrons ? 'warn' : 'muted',
  };
}

module.exports = { buildPlatformHealth };
