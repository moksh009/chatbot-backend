const crypto = require('crypto');
const Client = require('../models/Client');
const { decrypt } = require('../utils/encryption');

/**
 * Shopify order/fulfillment webhooks hitting /api/tracking/* must prove authenticity.
 * Resolves client by X-Shopify-Shop-Domain + HMAC (same secret strategy as shopifyWebhook.js).
 * Non-production: allows legacy ?clientId= when Shopify headers are absent (local/dev only).
 */
async function verifyShopifyTrackingWebhook(req, res, next) {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const shop = req.get('X-Shopify-Shop-Domain');

  if (!hmac || !shop) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).send('Missing Shopify webhook headers');
    }
    const clientId = req.query.clientId;
    if (!clientId) {
      return res.status(400).send('clientId query required (dev-only fallback when HMAC headers missing)');
    }
    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.status(404).send('Client not found');
    req.webhookClient = client;
    console.warn('[TrackingWebhook] Dev fallback: processed without Shopify HMAC headers');
    return next();
  }

  const client = await Client.findOne({ shopDomain: shop }).lean();
  if (!client) {
    return res.status(401).send('Unknown shop domain');
  }

  const secretRaw =
    client.commerce?.shopify?.webhookSecret ||
    client.shopifyWebhookSecret ||
    client.shopifyClientSecret;
  let secret;
  try {
    secret = decrypt(secretRaw);
  } catch {
    secret = secretRaw;
  }
  if (!secret) {
    return res.status(401).send('Webhook secret not configured');
  }

  const raw = req.rawBody;
  const buf = Buffer.isBuffer(raw)
    ? raw
    : Buffer.from(typeof raw === 'string' ? raw : JSON.stringify(req.body ?? {}), 'utf8');
  const hash = crypto.createHmac('sha256', secret).update(buf).digest('base64');

  if (hash !== hmac && process.env.NODE_ENV === 'production') {
    return res.status(401).send('Invalid signature');
  }

  req.webhookClient = client;
  next();
}

module.exports = { verifyShopifyTrackingWebhook };
