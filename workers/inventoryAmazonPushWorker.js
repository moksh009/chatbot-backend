'use strict';

const { Worker } = require('bullmq');
const { getQueueRedis } = require('../utils/core/redisFactory');
const { QUEUE_NAME } = require('../utils/messaging/queues/inventoryAmazonPushQueue');
const { pushAmazonInventoryInline } = require('../utils/inventory/pushAmazonInventory');
const log = require('../utils/core/logger')('InventoryAmazonPushWorker');

function startInventoryAmazonPushWorker() {
  const connection = getQueueRedis();
  if (!connection) return null;

  const worker = new Worker(QUEUE_NAME, async (job) => pushAmazonInventoryInline(job.data), {
    connection,
    concurrency: 20,
    limiter: { max: 1, duration: 1000, groupKey: 'clientId' },
  });

  worker.on('failed', (job, err) => log.error(`Amazon push ${job?.id}: ${err.message}`));
  log.info('Inventory Amazon push worker started');
  return worker;
}

module.exports = { startInventoryAmazonPushWorker };
