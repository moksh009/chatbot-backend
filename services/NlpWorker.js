const { Worker } = require('bullmq');
const Redis = require('ioredis');
const NlpEngineService = require('./NlpEngineService');

// Redis connection specific for the worker
const redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

/**
 * BullMQ Worker for the 'nlp-queue'.
 * Handles processing of aggregated messages after the 10-second delay.
 */
const nlpWorker = new Worker('nlp-queue', async (job) => {
  const { clientId, phoneNumber } = job.data;
  
  try {
    console.log(`[NLP_WORKER] Processing buffered text for Client: ${clientId}, Phone: ${phoneNumber}...`);

    const redisKey = `chat_buffer:${clientId}:${phoneNumber}`;

    // 1. Fetch the final aggregated string from Redis
    const finalString = await redisConnection.get(redisKey);

    if (!finalString) {
      console.warn(`[NLP_WORKER] No buffer found for key: ${redisKey}. Skipping.`);
      return;
    }

    // 2. Clear the buffer immediately to prevent double processing
    await redisConnection.del(redisKey);

    // 3. Pass to NLP Engine for classification
    await NlpEngineService.processIncomingText(clientId, phoneNumber, finalString);

    console.log(`[NLP_WORKER] Successfully processed job #${job.id}`);
  } catch (error) {
    console.error(`[NLP_WORKER] Error processing job #${job.id}:`, error);
    throw error; // Re-queue if it fails
  }
}, { 
  connection: redisConnection,
  concurrency: 10 // Adjust based on server capacity
});

nlpWorker.on('completed', (job) => {
  console.log(`[NLP_WORKER] Job ${job.id} completed.`);
});

nlpWorker.on('failed', (job, err) => {
  console.error(`[NLP_WORKER] Job ${job.id} failed with error: ${err.message}`);
});

module.exports = nlpWorker;
