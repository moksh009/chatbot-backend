'use strict';

const { Queue } = require('bullmq');
const { getConnection } = require('./queueConnection');

const QUEUE_NAME = 'amazon-inventory-pull';

let queue;

function getAmazonInventoryPullQueue() {
  const connection = getConnection();
  if (!connection) return null;
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 200,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      },
    });
  }
  return queue;
}

async function queueAmazonInventoryPull({ clientId, sellerSku = null }) {
  const q = getAmazonInventoryPullQueue();
  if (!q) {
    const { syncAmazonInventoryForClient } = require('../../inventory/amazonInventorySync');
    return syncAmazonInventoryForClient(clientId, {
      sellerSku: sellerSku || undefined,
      lastSyncSource: 'manual_refresh',
    });
  }
  const jobId = sellerSku ? `${clientId}:${sellerSku}` : clientId;
  return q.add(
    'pull',
    { clientId, sellerSku },
    { jobId, removeOnComplete: true }
  );
}

async function ensureAmazonInventoryRepeatable() {
  const q = getAmazonInventoryPullQueue();
  if (!q) return;
  const hours = Number(process.env.AMAZON_INVENTORY_PULL_HOURS || 4);
  const cron = `0 */${Math.max(1, Math.min(hours, 12))} * * *`;
  await q.add(
    'pull-all',
    { all: true },
    {
      repeat: { pattern: cron },
      jobId: 'amazon-inventory-pull-repeat',
    }
  );
}

module.exports = {
  QUEUE_NAME,
  getAmazonInventoryPullQueue,
  queueAmazonInventoryPull,
  ensureAmazonInventoryRepeatable,
};
