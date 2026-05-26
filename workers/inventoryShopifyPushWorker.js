'use strict';

const { Worker } = require('bullmq');
const { getQueueRedis } = require('../utils/core/redisFactory');
const {
  QUEUE_NAME,
  RETRY_DELAYS_MS,
} = require('../utils/messaging/queues/inventoryShopifyPushQueue');
const { pushInventoryToShopifyInline } = require('../utils/inventory/pushShopifyInventory');
const log = require('../utils/core/logger')('InventoryShopifyPushWorker');

function startInventoryShopifyPushWorker() {
  const connection = getQueueRedis();
  if (!connection) {
    log.warn('Redis unavailable — inventory Shopify push worker not started');
    return null;
  }

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      return pushInventoryToShopifyInline(job.data);
    },
    {
      connection,
      concurrency: 50,
      limiter: {
        max: 2,
        duration: 1000,
        groupKey: 'clientId',
      },
    }
  );

  worker.on('failed', (job, err) => {
    log.error(`Job ${job?.id} failed: ${err.message}`);
    const attempt = job?.attemptsMade || 0;
    if (attempt >= RETRY_DELAYS_MS.length && job?.data?.adjustmentId) {
      const InventoryAdjustment = require('../models/InventoryAdjustment');
      InventoryAdjustment.updateOne(
        { _id: job.data.adjustmentId },
        { $set: { syncStatus: 'failed' } }
      ).catch(() => {});
    }
  });

  log.info('Inventory Shopify push worker started');
  return worker;
}

module.exports = { startInventoryShopifyPushWorker };
