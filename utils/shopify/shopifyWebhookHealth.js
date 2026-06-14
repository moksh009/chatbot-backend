'use strict';

const axios = require('axios');
const { SHOPIFY_APP_WEBHOOK_TOPICS } = require('../../constants/shopifyWebhookTopics');
const shopifyAdminApiVersion = require('./shopifyAdminApiVersion');

/** Topics required for order messages / SAC — not full app catalog (products, customers, etc.). */
const ORDER_MESSAGE_WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/fulfilled',
  'orders/cancelled',
  'fulfillments/create',
  'fulfillments/update',
];

/**
 * Compare Shopify-registered webhooks against app-required topics.
 * @param {{ shopDomain: string, shopifyAccessToken: string, topics?: string[] }} params
 */
async function getShopifyWebhookHealth({ shopDomain, shopifyAccessToken, topics = SHOPIFY_APP_WEBHOOK_TOPICS }) {
  const requiredTopics = Array.isArray(topics) && topics.length ? topics : SHOPIFY_APP_WEBHOOK_TOPICS;

  if (!shopDomain || !shopifyAccessToken) {
    return {
      connected: false,
      allOk: false,
      registered: [],
      missing: [...requiredTopics],
      webhookUrl: null,
      error: 'shopify_not_connected',
      checkFailed: false,
      required: requiredTopics,
    };
  }

  const webhookUrl = `${process.env.SERVER_URL || 'https://api.topedgeai.com'}/api/shopify/webhook`;

  try {
    const res = await axios.get(
      `https://${shopDomain}/admin/api/${shopifyAdminApiVersion}/webhooks.json`,
      {
        headers: { 'X-Shopify-Access-Token': shopifyAccessToken },
        timeout: 12000,
      }
    );
    const hooks = res.data?.webhooks || [];
    const registered = [...new Set(hooks.map((h) => h.topic).filter(Boolean))];
    const missing = requiredTopics.filter((t) => !registered.includes(t));
    const wrongAddress = hooks.filter(
      (h) => requiredTopics.includes(h.topic) && h.address && h.address !== webhookUrl
    );

    return {
      connected: true,
      allOk: missing.length === 0,
      registered,
      missing,
      webhookUrl,
      wrongAddressCount: wrongAddress.length,
      required: requiredTopics,
      checkFailed: false,
    };
  } catch (err) {
    return {
      connected: true,
      allOk: false,
      registered: [],
      missing: [],
      webhookUrl,
      error: err.response?.data?.errors || err.message,
      checkFailed: true,
      required: requiredTopics,
    };
  }
}

module.exports = { getShopifyWebhookHealth, ORDER_MESSAGE_WEBHOOK_TOPICS, SHOPIFY_APP_WEBHOOK_TOPICS };
