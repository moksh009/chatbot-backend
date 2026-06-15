'use strict';

const { getAppRedis } = require('../core/redisFactory');
const { buildWorkerHealthSnapshot } = require('./workerHealth');

const CRON_KEY = 'cron:last_tick';

/**
 * Merchant-visible worker / cron health (uses BullMQ + RUN_WORKERS, not cron tick alone).
 */
async function buildPlatformHealth() {
  const worker = await buildWorkerHealthSnapshot();
  const redis = getAppRedis();
  let lastCronAt = worker.lastCronTick || null;
  let lastCronAgeMs = lastCronAt ? Date.now() - new Date(lastCronAt).getTime() : null;

  if (!lastCronAt && redis && redis.status === 'ready') {
    try {
      const last = await redis.get(CRON_KEY);
      if (last) {
        lastCronAt = new Date(Number(last)).toISOString();
        lastCronAgeMs = Date.now() - Number(last);
      }
    } catch {
      /* keep worker snapshot values */
    }
  }

  const runCrons =
    process.env.CRON_WORKER === 'true' ||
    (process.env.CRON_WORKER !== 'false' && process.env.RUN_CRONS !== 'false');

  const workersOk = worker.workerHealthy;
  const redisOk = worker.redisConnected;

  return {
    workersOk,
    redisOk,
    cronWorkerEnabled: runCrons,
    workersRunning: worker.workersRunning,
    lastCronAt,
    lastCronAgeMs,
    queues: worker.queues,
    automationsLabel: workersOk ? 'Running' : runCrons ? 'Delayed' : 'Paused (dev)',
    automationsStatus: workersOk ? 'ok' : runCrons ? 'warn' : 'muted',
  };
}

module.exports = { buildPlatformHealth };
