'use strict';

const { Queue } = require('bullmq');
const log = require('../utils/core/logger')('KnowledgeEmbeddingQueue');
const { getQueueRedis } = require('../utils/core/redisFactory');

let redisConnection = null;
let embeddingQueue = null;

if (process.env.REDIS_URL) {
  redisConnection = getQueueRedis();
}

if (redisConnection) {
  embeddingQueue = new Queue('knowledge-embedding', { connection: redisConnection });
  log.info('[KnowledgeEmbedding] Queue initialized.');
} else {
  log.warn('[KnowledgeEmbedding] Queue DISABLED (no REDIS_URL). Embeddings run inline.');
}

async function queueDocumentEmbedding(documentId, clientId) {
  if (!documentId) return;

  const runInline = !embeddingQueue || process.env.RUN_WORKERS !== 'true';

  if (runInline) {
    const { processDocumentEmbedding } = require('../utils/core/ragEngine');
    try {
      await processDocumentEmbedding(documentId);
    } catch (e) {
      log.error(`Inline embedding failed for ${documentId}:`, e.message);
    }
    return;
  }

  const jobId = `knowledge-embed-${documentId}`;
  try {
    const existing = await embeddingQueue.getJob(jobId);
    if (existing) await existing.remove();
  } catch (_) {}

  await embeddingQueue.add(
    'embed',
    { documentId, clientId },
    {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
    }
  );
}

module.exports = {
  embeddingQueue,
  queueDocumentEmbedding,
};
