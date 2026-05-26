'use strict';

const { Queue } = require('bullmq');
const { getConnection } = require('./queueConnection');

const QUEUE_NAME = 'inventory-amazon-push';

let queue;

function getInventoryAmazonPushQueue() {
  const connection = getConnection();
  if (!connection) return null;
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 400,
        attempts: 5,
      },
    });
  }
  return queue;
}

async function queueAmazonInventoryPush(payload) {
  const q = getInventoryAmazonPushQueue();
  const jobKey = `${payload.clientId}:${payload.sellerSku}`;
  if (!q) {
    const { pushAmazonInventoryInline } = require('../../inventory/pushAmazonInventory');
    return pushAmazonInventoryInline(payload);
  }
  return q.add('push', payload, { jobId: jobKey, delay: 10_000 });
}

module.exports = {
  QUEUE_NAME,
  getInventoryAmazonPushQueue,
  queueAmazonInventoryPush,
};
