const { Worker } = require('bullmq');
const { getQueueRedis } = require('../utils/redisFactory');
const NlpEngineService = require('./NlpEngineService');

const redisConnection = getQueueRedis();

/**
 * BullMQ Worker for the 'nlp-queue'.
 * Handles processing of aggregated messages after the delay window.
 */
const nlpWorker = redisConnection
  ? new Worker(
      'nlp-queue',
      async (job) => {
        const { clientId, phoneNumber } = job.data;

        try {
          console.log(`[NLP_WORKER] Processing buffered text for Client: ${clientId}, Phone: ${phoneNumber}...`);

          const redisKey = `chat_buffer:${clientId}:${phoneNumber}`;

          const finalString = await redisConnection.get(redisKey);

          if (!finalString) {
            console.warn(`[NLP_WORKER] No buffer found for key: ${redisKey}. Skipping.`);
            return;
          }

          await redisConnection.del(redisKey);

          await NlpEngineService.processIncomingText(clientId, phoneNumber, finalString);

          console.log(`[NLP_WORKER] Successfully processed job #${job.id}`);
        } catch (error) {
          console.error(`[NLP_WORKER] Error processing job #${job.id}:`, error);
          throw error;
        }
      },
      {
        connection: redisConnection,
        concurrency: 10
      }
    )
  : null;

if (nlpWorker) {
  nlpWorker.on('completed', (job) => {
    console.log(`[NLP_WORKER] Job ${job.id} completed.`);
  });

  nlpWorker.on('failed', (job, err) => {
    console.error(`[NLP_WORKER] Job ${job.id} failed:`, err);
  });
}

module.exports = nlpWorker;
