const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

// Initialize Redis connection
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

const nlpQueue = new Queue('nlp-queue', { connection: redisConnection });

class MessageBufferService {
  constructor() {
    this.bufferKeyPrefix = 'chat_buffer:';
  }

  /**
   * Ingests a new message into the sliding window buffer.
   * If a message comes within 10s, it's aggregated and the timer resets.
   */
  async ingestWebhookMessage(clientId, phoneNumber, incomingText) {
    try {
      const redisKey = `${this.bufferKeyPrefix}${clientId}:${phoneNumber}`;
      const jobId = `process_nlp:${clientId}:${phoneNumber}`;

      // 1. Get existing buffer
      const existingText = await redisConnection.get(redisKey);
      const aggregatedText = existingText ? `${existingText} ${incomingText}` : incomingText;

      // 2. Save updated string to Redis
      await redisConnection.set(redisKey, aggregatedText);

      // 3. Remove existing delayed job if it hasn't fired yet
      const existingJob = await nlpQueue.getJob(jobId);
      if (existingJob) {
        await existingJob.remove();
      }

      // 4. Add new job with 10s delay
      await nlpQueue.add('process_text', 
        { clientId, phoneNumber }, 
        { jobId, delay: 10000, removeOnComplete: true }
      );

      console.log(`[MessageBuffer] Buffered message for ${phoneNumber}. Aggregate length: ${aggregatedText.length}`);
    } catch (error) {
      console.error('[MessageBuffer] Error ingesting message:', error);
      throw error;
    }
  }

  /**
   * Clears the buffer for a specific phone number.
   */
  async clearBuffer(clientId, phoneNumber) {
    const redisKey = `${this.bufferKeyPrefix}${clientId}:${phoneNumber}`;
    await redisConnection.del(redisKey);
  }

  /**
   * Retrieves the current buffer content.
   */
  async getBuffer(clientId, phoneNumber) {
    const redisKey = `${this.bufferKeyPrefix}${clientId}:${phoneNumber}`;
    return await redisConnection.get(redisKey);
  }
}

module.exports = new MessageBufferService();
