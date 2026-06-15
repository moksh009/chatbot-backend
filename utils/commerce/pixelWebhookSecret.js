const crypto = require('crypto');
const Client = require('../../models/Client');
const { decrypt } = require('../core/encryption');

function generatePixelWebhookSecret() {
  return crypto.randomBytes(24).toString('hex');
}

function decryptPixelWebhookSecret(raw) {
  if (!raw) return '';
  try {
    const plain = decrypt(raw);
    return plain || String(raw);
  } catch {
    return String(raw);
  }
}

async function getPixelWebhookSecret(clientId) {
  if (!clientId) return '';
  const client = await Client.findOne({ clientId })
    .select('commerce.shopify.pixelWebhookSecret')
    .lean();
  return decryptPixelWebhookSecret(client?.commerce?.shopify?.pixelWebhookSecret);
}

/**
 * Ensure each connected store has a per-tenant pixel webhook secret.
 * Generated on Shopify connect; used by /api/client/:id/webhook/shopify/* routes.
 */
async function ensurePixelWebhookSecret(clientId) {
  const existing = await getPixelWebhookSecret(clientId);
  if (existing) return existing;

  const secret = generatePixelWebhookSecret();
  await Client.updateOne({ clientId }, { $set: { 'commerce.shopify.pixelWebhookSecret': secret } });

  try {
    const { clearClientCache } = require('../../middleware/apiCache');
    await clearClientCache(clientId);
  } catch (_) {}

  return secret;
}

module.exports = {
  generatePixelWebhookSecret,
  decryptPixelWebhookSecret,
  getPixelWebhookSecret,
  ensurePixelWebhookSecret,
};
