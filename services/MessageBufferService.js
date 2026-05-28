const { Queue } = require('bullmq');
const { getQueueRedis, isRedisReady } = require('../utils/core/redisFactory');

let nlpQueueSingleton = null;

function getNlpQueue() {
  const redisConnection = getQueueRedis();
  if (!redisConnection || !isRedisReady(redisConnection)) return null;
  if (!nlpQueueSingleton) {
    nlpQueueSingleton = new Queue('nlp-queue', { connection: redisConnection });
  }
  return nlpQueueSingleton;
}

/**
 * MessageBufferService — 3s sliding window for WhatsApp message aggregation.
 * Falls back to immediate NLP if Redis is down so bots keep replying.
 */
class MessageBufferService {
  async ingestWebhookMessage(clientId, phoneNumber, incomingText) {
    const redisConnection = getQueueRedis();
    const nlpQueue = getNlpQueue();

    if (!redisConnection || !nlpQueue || !isRedisReady(redisConnection)) {
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
            delay: 1000,
          },
        }
      );
    } catch (error) {
      console.error('[MessageBuffer] Redis unavailable — processing immediately:', error.message);
      const NlpEngineService = require('./NlpEngineService');
      await NlpEngineService.processIncomingText(clientId, phoneNumber, incomingText);
    }
  }

  async clearBuffer(clientId, phoneNumber) {
    const redisConnection = getQueueRedis();
    if (!redisConnection || !isRedisReady(redisConnection)) return;
    try {
      const redisKey = `chat_buffer:${clientId}:${phoneNumber}`;
      await redisConnection.del(redisKey);
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = new MessageBufferService();
