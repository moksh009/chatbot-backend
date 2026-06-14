'use strict';

const Order = require('../../models/Order');
const { aggregateOrderStatusMetrics } = require('./orderStatusMetrics');
const { getShopifyWebhookHealth } = require('../shopify/shopifyWebhookHealth');

/**
 * SAC order-messages overview: per-status metrics, recent failures, webhook health.
 */
async function buildOrderMessagesOverview(clientConfig) {
  const clientId = clientConfig.clientId;
  const orders = await Order.find({ clientId })
    .select('whatsappActivityLog orderNumber orderId')
    .lean();

  const { byStatus, failures } = aggregateOrderStatusMetrics(orders);
  const webhooks = await getShopifyWebhookHealth({
    shopDomain: clientConfig.shopDomain,
    shopifyAccessToken: clientConfig.shopifyAccessToken,
  });

  const wf =
    clientConfig.wizardFeatures && typeof clientConfig.wizardFeatures.toObject === 'function'
      ? clientConfig.wizardFeatures.toObject()
      : clientConfig.wizardFeatures || {};

  let messagingActivity = null;
  let templateReadiness = null;
  try {
    const { buildMessagingActivitySummary } = require('../../services/messagingActivityService');
    messagingActivity = await buildMessagingActivitySummary(clientConfig);
  } catch (err) {
    console.warn('[OrderMessagesOverview] messaging activity:', err.message);
  }
  try {
    const { buildCartRecoveryTemplateReadiness } = require('./cartRecoveryTemplateReadiness');
    templateReadiness = buildCartRecoveryTemplateReadiness(clientConfig);
  } catch (err) {
    console.warn('[OrderMessagesOverview] template readiness:', err.message);
  }

  return {
    metrics: byStatus,
    failures: failures.slice(0, 80),
    webhooks,
    features: {
      enableAutoShopifyShippedWhatsApp: wf.enableAutoShopifyShippedWhatsApp !== false,
    },
    orderTriggers: clientConfig.nicheData?.orderStatusTemplates || {},
    messagingActivity,
    templateReadiness,
    cronHealth: messagingActivity?.cronHealth || null,
  };
}

module.exports = { buildOrderMessagesOverview };
