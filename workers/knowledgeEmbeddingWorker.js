'use strict';

require('dotenv').config();

const { Worker } = require('bullmq');
const log = require('../utils/core/logger')('KnowledgeEmbeddingWorker');
const { getQueueRedis } = require('../utils/core/redisFactory');
const { processDocumentEmbedding } = require('../utils/core/ragEngine');

const redisConnection = getQueueRedis();

if (redisConnection) {
  const worker = new Worker(
    'knowledge-embedding',
    async (job) => {
      const { documentId, force } = job.data || {};
      if (!documentId) return;
      await processDocumentEmbedding(documentId, { force: !!force });
    },
    { connection: redisConnection, concurrency: 2 }
  );

  worker.on('completed', (job) => {
    log.info(`Embedding job complete: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    log.error(`Embedding job failed: ${job?.id}`, err?.message);
  });

  log.info('[KnowledgeEmbeddingWorker] Started.');
} else {
  log.warn('[KnowledgeEmbeddingWorker] Not started — no Redis connection.');
}
