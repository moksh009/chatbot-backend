const { Queue } = require('bullmq');
const { getQueueRedis } = require('../utils/redisFactory');

const redisConnection = getQueueRedis();

const nlpQueue = redisConnection
  ? new Queue('nlp-queue', {
      connection: redisConnection
    })
  : null;

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
    if (!redisConnection || !nlpQueue) {
      const NlpEngineService = require('./NlpEngineService');
      await NlpEngineService.processIncomingText(clientId, phoneNumber, incomingText);
      return;
    }
    try {
      const redisKey = `chat_buffer:${clientId}:${phoneNumber}`;
      const jobId = `process_nlp:${clientId}:${phoneNumber}`;

      const existingText = await redisConnection.get(redisKey);
      const updatedText = existingText ? `${existingText} ${incomingText}` : incomingText;

      await redisConnection.set(redisKey, updatedText);

      const existingJob = await nlpQueue.getJob(jobId);
      if (existingJob) {
        await existingJob.remove();
      }

      await nlpQueue.add(
        'process_text',
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

      console.log(`[MessageBuffer] Aggregated message for ${phoneNumber}. Delay set to 3s.`);
    } catch (error) {
      console.error('[MessageBuffer] Error in ingestWebhookMessage:', error);
      throw error;
    }
  }

  /**
   * Utility to clear the buffer manually if needed.
   */
  async clearBuffer(clientId, phoneNumber) {
    if (!redisConnection) return;
    const redisKey = `chat_buffer:${clientId}:${phoneNumber}`;
    await redisConnection.del(redisKey);
  }
}

module.exports = new MessageBufferService();
