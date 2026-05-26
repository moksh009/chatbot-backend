'use strict';

const { Queue } = require('bullmq');
const { getConnection } = require('./queueConnection');

const QUEUE_NAME = 'inventory-shopify-push';
const RETRY_DELAYS_MS = [0, 5000, 30_000, 120_000, 600_000, 1_800_000];

let queue;

function getInventoryShopifyPushQueue() {
  const connection = getConnection();
  if (!connection) return null;
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: 300,
        removeOnFail: 500,
        attempts: 6,
        backoff: { type: 'custom' },
      },
    });
  }
  return queue;
}

async function queueShopifyInventoryPush(payload) {
  const q = getInventoryShopifyPushQueue();
  const jobKey = `${payload.clientId}:${payload.sku}:${payload.locationId || 'default'}`;
  if (!q) {
    const { pushInventoryToShopifyInline } = require('../../inventory/pushShopifyInventory');
    return pushInventoryToShopifyInline(payload);
  }
  const existing = await q.getJob(jobKey).catch(() => null);
  if (existing) {
    await existing.updateData({ ...existing.data, ...payload, coalescedAt: Date.now() });
    return existing;
  }
  return q.add('push', payload, {
    jobId: jobKey,
    delay: 10_000,
  });
}

module.exports = {
  QUEUE_NAME,
  RETRY_DELAYS_MS,
  getInventoryShopifyPushQueue,
  queueShopifyInventoryPush,
};
