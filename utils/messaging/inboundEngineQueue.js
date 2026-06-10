'use strict';

const { Queue, Worker } = require('bullmq');
const { getQueueRedis, isRedisReady } = require('../core/redisFactory');
const log = require('../core/logger')('InboundEngineQueue');

let inboundQueue = null;
let inboundWorker = null;

function getInboundEngineQueue() {
  const conn = getQueueRedis();
  if (!conn || !isRedisReady(conn)) return null;
  if (!inboundQueue) {
    inboundQueue = new Queue('inbound-wa-engine', { connection: conn });
  }
  return inboundQueue;
}

/**
 * Durable retry when session lock is busy (Phase 5).
 */
async function enqueueInboundEngineRetry({ clientId, phone, parsedMessage, delayMs = 1500 }) {
  const q = getInboundEngineQueue();
  if (!q) return false;
  const jobId = `inbound:${clientId}:${phone}`;
  try {
    const existing = await q.getJob(jobId);
    if (existing) await existing.remove();
    await q.add(
      'run',
      { clientId, phone, parsedMessage },
      {
        jobId,
        delay: Math.max(500, Number(delayMs) || 1500),
        removeOnComplete: true,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: 'fixed', delay: 1500 },
      }
    );
    return true;
  } catch (err) {
    log.warn(`enqueue failed ${clientId}:${phone}`, { error: err.message });
    return false;
  }
}

function startInboundEngineWorker() {
  if (process.env.INBOUND_ENGINE_WORKER === 'false') return null;
  if (inboundWorker) return inboundWorker;

  const conn = getQueueRedis();
  if (!conn || !isRedisReady(conn)) {
    log.info('Inbound engine worker skipped — Redis not ready');
    return null;
  }

  inboundWorker = new Worker(
    'inbound-wa-engine',
    async (job) => {
      const { clientId, parsedMessage } = job.data || {};
      if (!clientId || !parsedMessage) return;

      const Client = require('../../models/Client');
      const { runDualBrainEngine } = require('../commerce/dualBrainEngine');
      const client = await Client.findOne({ clientId }).lean();
      if (!client) return;

      await runDualBrainEngine(parsedMessage, client);
    },
    {
      connection: conn,
      concurrency: Number(process.env.INBOUND_ENGINE_CONCURRENCY || 25),
    }
  );

  inboundWorker.on('failed', (job, err) => {
    log.warn(`Job ${job?.id} failed: ${err.message}`);
  });

  log.info('Inbound WA engine worker started');
  return inboundWorker;
}

module.exports = {
  getInboundEngineQueue,
  enqueueInboundEngineRetry,
  startInboundEngineWorker,
};
