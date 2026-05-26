'use strict';

const { Worker } = require('bullmq');
const { getQueueRedis } = require('../utils/core/redisFactory');
const { QUEUE_NAME } = require('../utils/messaging/queues/amazonInventoryPullQueue');
const {
  syncAmazonInventoryForClient,
  enqueueAmazonPullForAllClients,
} = require('../utils/inventory/amazonInventorySync');
const log = require('../utils/core/logger')('AmazonInventorySyncWorker');

function startAmazonInventorySyncWorker() {
  const connection = getQueueRedis();
  if (!connection) {
    log.warn('Redis unavailable — Amazon inventory pull worker not started');
    return null;
  }

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.data?.all) {
        return enqueueAmazonPullForAllClients();
      }
      const { clientId, sellerSku } = job.data;
      return syncAmazonInventoryForClient(clientId, {
        sellerSku: sellerSku || undefined,
        lastSyncSource: sellerSku ? 'manual_refresh' : 'cron',
      });
    },
    {
      connection,
      concurrency: 10,
      limiter: { max: 1, duration: 1000, groupKey: 'clientId' },
    }
  );

  worker.on('failed', (job, err) => {
    log.error(`Amazon inventory pull ${job?.id} failed: ${err.message}`);
  });

  const { ensureAmazonInventoryRepeatable } = require('../utils/messaging/queues/amazonInventoryPullQueue');
  ensureAmazonInventoryRepeatable().catch((e) => log.warn(`Repeatable schedule: ${e.message}`));

  log.info('Amazon inventory sync worker started');
  return worker;
}

module.exports = { startAmazonInventorySyncWorker };
