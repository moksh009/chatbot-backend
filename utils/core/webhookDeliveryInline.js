'use strict';

/**
 * Fallback inline delivery when Redis/BullMQ unavailable.
 */
const axios = require('axios');
const crypto = require('crypto');
const WebhookConfig = require('../../models/WebhookConfig');
const WebhookDeliveryLog = require('../../models/WebhookDeliveryLog');
const { transformEnterprisePayload } = require('./webhookDelivery');

async function deliverWebhookInline({ configId, event, payload, clientId, deliveryId, attempt = 1 }, attemptNum = attempt) {
  const config = await WebhookConfig.findById(configId).lean();
  if (!config || !config.isActive) return;

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
      consecutiveFailures: 0,
      $inc: { totalFired: 1 },
    });
    await WebhookDeliveryLog.create({
      webhookConfigId: config._id,
      clientId,
      event,
      status: resp.status,
      deliveredAt: new Date(),
      attempt: attemptNum,
      failed: false,
    });
  } catch (err) {
    const status = err.response?.status || 0;
    await WebhookDeliveryLog.create({
      webhookConfigId: config._id,
      clientId,
      event,
      status,
      error: err.message,
      deliveredAt: new Date(),
      attempt: attemptNum,
      failed: true,
      isDead: attemptNum >= 6,
    });
    if (attemptNum < 6 && (status >= 500 || status === 408 || status === 429 || !status)) {
      const { delayForAttempt } = require('../messaging/queues/webhookDeliveryQueue');
      setTimeout(
        () => deliverWebhookInline({ configId, event, payload, clientId, deliveryId, attempt: attemptNum + 1 }, attemptNum + 1),
        delayForAttempt(attemptNum)
      );
    }
  }
}

module.exports = { deliverWebhookInline };
