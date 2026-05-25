'use strict';

const axios = require('axios');
const { SHOPIFY_APP_WEBHOOK_TOPICS } = require('../../constants/shopifyWebhookTopics');
const shopifyAdminApiVersion = require('./shopifyAdminApiVersion');

/**
 * Compare Shopify-registered webhooks against app-required topics.
 * @param {{ shopDomain: string, shopifyAccessToken: string }} params
 */
async function getShopifyWebhookHealth({ shopDomain, shopifyAccessToken }) {
  if (!shopDomain || !shopifyAccessToken) {
    return {
      connected: false,
      allOk: false,
      registered: [],
      missing: [...SHOPIFY_APP_WEBHOOK_TOPICS],
      webhookUrl: null,
      error: 'shopify_not_connected',
    };
  }

  const webhookUrl = `${process.env.SERVER_URL || 'https://chatbot-backend-lg5y.onrender.com'}/api/shopify/webhook`;

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
    const missing = SHOPIFY_APP_WEBHOOK_TOPICS.filter((t) => !registered.includes(t));
    const wrongAddress = hooks.filter(
      (h) => SHOPIFY_APP_WEBHOOK_TOPICS.includes(h.topic) && h.address && h.address !== webhookUrl
    );

    return {
      connected: true,
      allOk: missing.length === 0,
      registered,
      missing,
      webhookUrl,
      wrongAddressCount: wrongAddress.length,
      required: SHOPIFY_APP_WEBHOOK_TOPICS,
    };
  } catch (err) {
    return {
      connected: true,
      allOk: false,
      registered: [],
      missing: [...SHOPIFY_APP_WEBHOOK_TOPICS],
      webhookUrl,
      error: err.response?.data?.errors || err.message,
    };
  }
}

module.exports = { getShopifyWebhookHealth };
