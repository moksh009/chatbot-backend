'use strict';

const { getAppRedis, isRedisReady } = require('../core/redisFactory');
const { getCampaignDispatchQueue } = require('../messaging/queues/campaignDispatchQueue');
const { getSequenceDispatchQueue } = require('../messaging/queues/sequenceDispatchQueue');

const STALE_CRON_MS = 10 * 60 * 1000;
const ABANDONED_CART_TICK_KEY = 'cron:abandoned-cart:last-tick';
const GLOBAL_CRON_TICK_KEY = 'cron:last_tick';

async function readQueueCounts(getQueue) {
  try {
    const q = getQueue();
    if (!q) return { waiting: 0, active: 0, failed: 0, unavailable: true };
    const counts = await q.getJobCounts('waiting', 'active', 'failed', 'delayed');
    return {
      waiting: (counts.waiting || 0) + (counts.delayed || 0),
      active: counts.active || 0,
      failed: counts.failed || 0,
      unavailable: false,
    };
  } catch {
    return { waiting: 0, active: 0, failed: 0, unavailable: true };
  }
}

async function pingRedis(redis) {
  if (!redis) return false;
  try {
    if (!isRedisReady(redis)) return false;
    const pong = await redis.ping();
    return pong === 'PONG' || pong === 'pong';
  } catch {
    return false;
  }
}

/**
 * True worker/cron health snapshot for ops + merchant connection-status.
 */
async function buildWorkerHealthSnapshot() {
  const cronRunning = process.env.RUN_CRONS === 'true';
  const workersRunning = process.env.RUN_WORKERS === 'true';
  const redis = getAppRedis();
  const redisConnected = await pingRedis(redis);

  let lastCronTick = null;
  let abandonedCartLastTick = null;
  let abandonedCartIsRunning = false;

  if (redis && redisConnected) {
    try {
      const [globalTick, cartTick, cartLock] = await Promise.all([
        redis.get(GLOBAL_CRON_TICK_KEY),
        redis.get(ABANDONED_CART_TICK_KEY),
        redis.get('cron:abandoned-cart:global-lock'),
      ]);
      if (globalTick) lastCronTick = new Date(Number(globalTick)).toISOString();
      else if (cartTick) lastCronTick = cartTick;
      if (cartTick) abandonedCartLastTick = cartTick;
      abandonedCartIsRunning = Boolean(cartLock);
    } catch {
      // keep defaults
    }
  }

  const [campaignDispatch, sequenceDispatch] = await Promise.all([
    readQueueCounts(getCampaignDispatchQueue),
    readQueueCounts(getSequenceDispatchQueue),
  ]);

  const cronFresh =
    Boolean(lastCronTick) &&
    Date.now() - new Date(lastCronTick).getTime() < STALE_CRON_MS;

  const queuesAccessible =
    !campaignDispatch.unavailable && !sequenceDispatch.unavailable;

  const workerHealthy =
    cronRunning &&
    workersRunning &&
    redisConnected &&
    cronFresh &&
    queuesAccessible;

  return {
    cronRunning,
    workersRunning,
    redisConnected,
    queues: {
      campaignDispatch: {
        waiting: campaignDispatch.waiting,
        active: campaignDispatch.active,
        failed: campaignDispatch.failed,
      },
      sequenceDispatch: {
        waiting: sequenceDispatch.waiting,
        active: sequenceDispatch.active,
        failed: sequenceDispatch.failed,
      },
      abandonedCart: {
        lastTick: abandonedCartLastTick,
        isRunning: abandonedCartIsRunning,
      },
    },
    lastCronTick,
    workerHealthy,
  };
}

module.exports = { buildWorkerHealthSnapshot };
