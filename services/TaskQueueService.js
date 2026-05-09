const { Queue } = require('bullmq');
const { getQueueRedis } = require('../utils/redisFactory');

const redisConnection = getQueueRedis();

// Generic Enterprise Task Queue
const taskQueue = redisConnection
  ? new Queue('enterprise-tasks', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000
        },
        removeOnComplete: true,
        removeOnFail: 1000 // Keep failed jobs for 1000 records to audit
      }
    })
  : null;

/**
 * TaskQueueService
 * Centralizes offloading heavy operations from the HTTP loop.
 */
class TaskQueueService {
  /**
   * @param {string} taskType - e.g. 'SHOPIFY_SYNC', 'BROADCAST', 'AI_GENERATION'
   * @param {object} data - Payload required for the task
   */
  async addTask(taskType, data, opts = {}) {
    if (!taskQueue) {
      console.error('[TaskQueue] Redis unavailable — cannot enqueue task:', taskType);
      throw new Error('Task queue unavailable (Redis)');
    }
    try {
      const job = await taskQueue.add(taskType, data, opts);
      console.log(`[TaskQueue] Enqueued task: ${taskType} (Job ID: ${job.id})`);
      return job;
    } catch (err) {
      console.error(`[TaskQueue] Error enqueuing task ${taskType}:`, err);
      throw err;
    }
  }
}

module.exports = new TaskQueueService();
