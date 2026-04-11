const { Worker } = require('bullmq');
const Redis = require('ioredis');
const NlpEngineService = require('./NlpEngineService');

const redisConnection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

/**
 * BullMQ Worker for the 'nlp-queue'.
 * Responds to delayed jobs after the sliding window timer expires.
 */
const nlpWorker = new Worker('nlp-queue', async (job) => {
  const { clientId, phoneNumber } = job.data;
  
  try {
    console.log(`[NLP_WORKER] Processing buffered text for ${phoneNumber}...`);

    // 1. Fetch the final aggregated string from Redis
    const redisKey = `chat_buffer:${clientId}:${phoneNumber}`;
    const finalString = await redisConnection.get(redisKey);

    if (!finalString) {
      console.warn(`[NLP_WORKER] No buffer found for ${phoneNumber}. Skipping.`);
      return;
    }

    // 2. Pass to NLP Engine for classification and action execution
    await NlpEngineService.processIncomingText(clientId, phoneNumber, finalString);

    // 3. Clear the buffer
    await redisConnection.del(redisKey);

    console.log(`[NLP_WORKER] Successfully processed and cleared buffer for ${phoneNumber}`);
  } catch (error) {
    console.error(`[NLP_WORKER] Error processing job ${job.id}:`, error);
    throw error; // Re-queue if it fails
  }
}, { 
  connection: redisConnection,
  concurrency: 5 // Process 5 jobs at once
});

nlpWorker.on('completed', (job) => {
  console.log(`[NLP_WORKER] Job ${job.id} completed.`);
});

nlpWorker.on('failed', (job, err) => {
  console.error(`[NLP_WORKER] Job ${job.id} failed:`, err.message);
});

module.exports = nlpWorker;
