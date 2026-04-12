const { Queue } = require('bullmq');
const Redis = require('ioredis');

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
});

// Generic Enterprise Task Queue
const taskQueue = new Queue('enterprise-tasks', { 
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: 1000, // Keep failed jobs for 1000 records to audit
    }
});

/**
 * TaskQueueService
 * Centralizes offloading heavy operations from the HTTP loop.
 */
class TaskQueueService {
    /**
     * @param {string} taskType - e.g., 'SHOPIFY_SYNC', 'BROADCAST', 'AI_GENERATION'
     * @param {object} data - Payload required for the task
     */
    async addTask(taskType, data) {
        try {
            const job = await taskQueue.add(taskType, data);
            console.log(`[TaskQueue] Enqueued task: ${taskType} (Job ID: ${job.id})`);
            return job;
        } catch (err) {
            console.error(`[TaskQueue] Error enqueuing task ${taskType}:`, err);
            throw err;
        }
    }
}

module.exports = new TaskQueueService();
