const { Worker } = require('bullmq');
const Redis = require('ioredis');
const log = require('../utils/logger')('TaskWorker');

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
});

/**
 * TaskWorker
 * Processes asynchronous tasks for scaling.
 */
const taskWorker = new Worker('enterprise-tasks', async (job) => {
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
