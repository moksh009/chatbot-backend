'use strict';

const { Queue } = require('bullmq');
const log = require('../utils/core/logger')('KnowledgeEmbeddingQueue');
const { getQueueRedis } = require('../utils/core/redisFactory');
const KnowledgeDocument = require('../models/KnowledgeDocument');

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

async function shouldQueueEmbedding(documentId, { force = false } = {}) {
  const doc = await KnowledgeDocument.findById(documentId)
    .select('status embeddingStatus')
    .lean();
  if (!doc || doc.status !== 'active') return false;
  if (force) return true;
  if (doc.embeddingStatus === 'complete') return false;
  if (doc.embeddingStatus === 'failed') return false;
  if (doc.embeddingStatus === 'processing') return false;
  return doc.embeddingStatus === 'pending';
}

async function queueDocumentEmbedding(documentId, clientId, { force = false } = {}) {
  if (!documentId) return;

  const eligible = await shouldQueueEmbedding(documentId, { force });
  if (!eligible) return;

  const runInline = !embeddingQueue || process.env.RUN_WORKERS !== 'true';

  if (runInline) {
    const { processDocumentEmbedding } = require('../utils/core/ragEngine');
    try {
      await processDocumentEmbedding(documentId, { force });
    } catch (e) {
      log.error(`Inline embedding failed for ${documentId}:`, e.message);
    }
    return;
  }

  const jobId = `knowledge-embed-${documentId}`;
  try {
    const existing = await embeddingQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active' || state === 'waiting' || state === 'delayed') {
        return;
      }
      await existing.remove();
    }
  } catch (_) {}

  await embeddingQueue.add(
    'embed',
    { documentId, clientId, force: !!force },
    {
      jobId,
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    }
  );
}

module.exports = {
  embeddingQueue,
  queueDocumentEmbedding,
  shouldQueueEmbedding,
};
