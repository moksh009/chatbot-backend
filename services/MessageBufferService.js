const { Queue } = require('bullmq');
const Redis = require('ioredis');

// Initialize Redis connection for buffering and queueing
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

// Initialize the NLP Queue
const nlpQueue = new Queue('nlp-queue', { 
  connection: redisConnection 
});

/**
 * MessageBufferService
 * Implements a 10-second sliding window for WhatsApp message aggregation.
 * Prevents fragmented processing of multiple short messages.
 */
class MessageBufferService {
  /**
   * Ingests a new message and (re)starts the 10-second aggregation timer.
   */
  async ingestWebhookMessage(clientId, phoneNumber, incomingText) {
    try {
      const redisKey = `chat_buffer:${clientId}:${phoneNumber}`;
      const jobId = `process_nlp:${clientId}:${phoneNumber}`;

      // 1. Fetch and aggregate text in Redis
      const existingText = await redisConnection.get(redisKey);
      const updatedText = existingText ? `${existingText} ${incomingText}` : incomingText;
      
      await redisConnection.set(redisKey, updatedText);

      // 2. Manage the rolling BullMQ job
      // If a job already exists for this number, remove it to reset the timer
      const existingJob = await nlpQueue.getJob(jobId);
      if (existingJob) {
        await existingJob.remove();
      }

      // 3. Add a new delayed job (10 seconds)
      await nlpQueue.add('process_text', 
        { clientId, phoneNumber }, 
        { 
          jobId, 
          delay: 3000, 
          removeOnComplete: true,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 1000
          }
        }
      );

      console.log(`[MessageBuffer] Aggregated message for ${phoneNumber}. Delay reset to 10s.`);
    } catch (error) {
      console.error('[MessageBuffer] Error in ingestWebhookMessage:', error);
      throw error;
    }
  }

  /**
   * Utility to clear the buffer manually if needed.
   */
  async clearBuffer(clientId, phoneNumber) {
    const redisKey = `chat_buffer:${clientId}:${phoneNumber}`;
    await redisConnection.del(redisKey);
  }
}

module.exports = new MessageBufferService();
