'use strict';

const { Queue } = require('bullmq');
const { getConnection } = require('./queueConnection');
const { webhookDeliveryJobId } = require('./jobIdUtils');

const QUEUE_NAME = 'webhook-delivery';
const RETRY_DELAYS_MS = [0, 30_000, 120_000, 600_000, 1_800_000, 7_200_000];

let queue;

function getWebhookDeliveryQueue() {
  const connection = getConnection();
  if (!connection) return null;
  if (!queue) {
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: 200,
        removeOnFail: 500,
        attempts: 1,
      },
    });
  }
  return queue;
}

function delayForAttempt(attempt) {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 7_200_000;
}

async function enqueueWebhookDelivery(jobData, { attempt = 1 } = {}) {
  const q = getWebhookDeliveryQueue();
  if (!q) {
    const { deliverWebhookInline } = require('../../core/webhookDeliveryInline');
    return deliverWebhookInline(jobData, attempt);
  }
  const delay = delayForAttempt(attempt - 1);
  const deliveryId = jobData.deliveryId || require('crypto').randomUUID();
  return q.add(
    'deliver',
    { ...jobData, deliveryId, attempt },
    {
      jobId: webhookDeliveryJobId(deliveryId, attempt),
      delay,
    }
  );
}

module.exports = {
  QUEUE_NAME,
  RETRY_DELAYS_MS,
  getWebhookDeliveryQueue,
  enqueueWebhookDelivery,
  delayForAttempt,
};
