const { Worker } = require('bullmq');
const Redis = require('ioredis');
const log = require('../utils/logger')('TaskWorker');

const isInternalRenderRedis = (process.env.REDIS_URL || '').includes('red-');
const isRunningOnRender = !!process.env.RENDER;

let redisConnection = null;

if (isInternalRenderRedis && !isRunningOnRender) {
  log.warn('[TaskWorker] ⚠️ Render-internal Redis detected locally. Worker is DISABLED.');
} else {
  redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => {
      if (times > 3) {
        log.error('[TaskWorker] Redis connection failed persistently. Disabling worker.');
        return null; // Stop retrying
      }
      return Math.min(times * 100, 3000);
    }
  });

  redisConnection.on('error', (err) => {
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      log.warn('[TaskWorker] ⚠️ Redis unreachable. Background Enterprise Tasks are DISABLED.');
    } else {
      log.error('[TaskWorker] Redis Error:', err.message);
    }
  });
}

/**
 * TaskWorker
 */
const taskWorker = redisConnection ? new Worker('enterprise-tasks', async (job) => {
    const { type, data } = job;
    log.info(`[TaskWorker] Picked up job ${job.id} of type: ${job.name}`);

    try {
        switch (job.name) {
            case 'SHOPIFY_SYNC':
                // Logic for background Shopify sync 
                const { syncStoreData } = require('../utils/storeSyncService'); // Example hypothetical service
                await syncStoreData(data.clientId, data.shopUrl);
                break;
            
            case 'BROADCAST_CAMPAIGN':
                // Logic for mass campaign sending
                const { processBroadcast } = require('../utils/broadcastEngine');
                await processBroadcast(data);
                break;

            case 'AI_PERSONA_SYNC':
                // Logic for syncing persona across 100+ nodes in background
                const { syncPersonaToNodes } = require('../utils/personaEngine');
                await syncPersonaToNodes(data.clientId, data.persona);
                break;

            default:
                log.warn(`[TaskWorker] No handler found for task type: ${job.name}`);
        }
    } catch (err) {
        log.error(`[TaskWorker] Job ${job.id} failed:`, err);
        throw err; // Ensure BullMQ increments attempt count
    }
}, {
    connection: redisConnection,
    concurrency: 10, // Process 10 scale-tasks in parallel per worker instance
});

taskWorker.on('completed', (job) => {
    log.info(`[TaskWorker] Job ${job.id} (${job.name}) completed successfully.`);
});

taskWorker.on('failed', (job, err) => {
    log.error(`[TaskWorker] Job ${job.id} (${job.name}) failed with error: ${err.message}`);
});

module.exports = taskWorker;
