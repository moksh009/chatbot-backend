'use strict';

const os = require('os');
const { Worker } = require('bullmq');
const axios = require('axios');
const crypto = require('crypto');
const WebhookConfig = require('../models/WebhookConfig');
const WebhookDeliveryLog = require('../models/WebhookDeliveryLog');
const DeadLetterWebhook = require('../models/DeadLetterWebhook');
const { acquire, release } = require('../utils/messaging/concurrency/tenantConcurrencyGate');
const { getConnection } = require('../utils/messaging/queues/queueConnection');
const { enqueueWebhookDelivery, delayForAttempt, QUEUE_NAME } = require('../utils/messaging/queues/webhookDeliveryQueue');
const { transformEnterprisePayload } = require('../utils/core/webhookDelivery');
const log = require('../utils/core/logger')('WebhookDeliveryWorker');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const CONCURRENCY = Number(process.env.PHASE9_WEBHOOK_CONCURRENCY || 50);
const MAX_ATTEMPTS = 6;

function recordMetric(name, tags = {}) {
  try {
    const metrics = require('../services/observability/metricsCollector');
    metrics.record(name, 1, tags);
  } catch {
    /* noop */
  }
}

async function pauseSubscription(config, clientId, deliveryId, event, payload, errMsg, status) {
  await WebhookConfig.findByIdAndUpdate(config._id, {
    isActive: false,
    pausedReason: 'consecutive_failures',
    pausedAt: new Date(),
    lastError: errMsg,
  });
  await DeadLetterWebhook.create({
    subscriptionId: config._id,
    clientId,
    deliveryId,
    event,
    payload,
    lastError: errMsg,
    lastStatus: status,
    deliveryAttempts: MAX_ATTEMPTS,
  });
  recordMetric('webhook_delivery_dead_letter', { clientId });
  const { auditLog } = require('../services/audit/auditWriter');
  auditLog({
    category: 'webhook',
    action: 'webhook_subscription_paused',
    severity: 'high',
    clientId,
    actor: { type: 'system', source: 'webhook_delivery_worker' },
    details: { subscriptionId: String(config._id), url: config.url },
  });
}

async function processWebhookJob(job) {
  const { configId, event, payload, clientId, deliveryId, attempt = 1 } = job.data;
  recordMetric('webhook_delivery_attempt', { clientId });

  const config = await WebhookConfig.findById(configId).lean();
  if (!config || !config.isActive) return;

  const Client = require('../models/Client');
  const client = await Client.findOne({ clientId }).select('clientId tier plan').lean();
  const gate = await acquire({ client: client || { clientId }, clientId, channel: 'webhook' });
  if (!gate.acquired) {
    await enqueueWebhookDelivery(job.data, { attempt });
    return;
  }

  const body = {
    event,
    timestamp: new Date().toISOString(),
    clientId: String(clientId),
    data: transformEnterprisePayload(payload, config.mapping || {}),
    webhookId: config._id,
    delivery_id: deliveryId,
  };

  const signature = crypto.createHmac('sha256', config.secret).update(JSON.stringify(body)).digest('hex');
  const headers = {
    'Content-Type': 'application/json',
    'X-TopEdge-Event': event,
    'X-TopEdge-Signature': `sha256=${signature}`,
    'X-TopEdge-Event-Id': deliveryId,
    'X-TopEdge-Delivery': deliveryId,
  };

  try {
    const resp = await axios.post(config.url, body, { headers, timeout: 10000 });
    await WebhookConfig.findByIdAndUpdate(config._id, {
      lastFiredAt: new Date(),
      lastStatus: resp.status,
      lastError: null,
      consecutiveFailures: 0,
      pausedReason: null,
      $inc: { totalFired: 1 },
    });
    await WebhookDeliveryLog.create({
      webhookConfigId: config._id,
      clientId,
      event,
      status: resp.status,
      deliveredAt: new Date(),
      attempt,
      failed: false,
    });
    recordMetric('webhook_delivery_success', { clientId });
  } catch (err) {
    const status = err.response?.status || 0;
    const retryable = status >= 500 || status === 408 || status === 429 || !status;
    const permanent = status >= 400 && status < 500 && !retryable;

    await WebhookDeliveryLog.create({
      webhookConfigId: config._id,
      clientId,
      event,
      status,
      error: err.message,
      deliveredAt: new Date(),
      attempt,
      failed: true,
      isDead: permanent || attempt >= MAX_ATTEMPTS,
    });
    recordMetric('webhook_delivery_failure', { clientId });

    if (permanent || attempt >= MAX_ATTEMPTS) {
      await WebhookConfig.findByIdAndUpdate(config._id, { $inc: { consecutiveFailures: 1 } });
      const updated = await WebhookConfig.findById(config._id).lean();
      if ((updated?.consecutiveFailures || 0) >= 6 || attempt >= MAX_ATTEMPTS) {
        await pauseSubscription(config, clientId, deliveryId, event, payload, err.message, status);
      }
      return;
    }

    if (retryable && attempt < MAX_ATTEMPTS) {
      await enqueueWebhookDelivery(
        { configId, event, payload, clientId, deliveryId },
        { attempt: attempt + 1 }
      );
    }
  } finally {
    await release({ clientId, channel: 'webhook' });
  }
}

function startWebhookDeliveryWorker() {
  const connection = getConnection();
  if (!connection) {
    log.warn('No Redis — webhook delivery worker not started (inline fallback only)');
    return null;
  }
  const worker = new Worker(QUEUE_NAME, processWebhookJob, {
    connection,
    concurrency: CONCURRENCY,
  });
  worker.on('failed', (job, err) => log.error(`Job failed ${job?.id}: ${err.message}`));
  log.info(`Webhook delivery worker started (concurrency=${CONCURRENCY})`);
  return worker;
}

module.exports = { startWebhookDeliveryWorker, processWebhookJob };
