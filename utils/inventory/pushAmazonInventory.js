'use strict';

const Client = require('../../models/Client');
const AmazonSPAPI = require('../commerce/amazonSPAPI');
const InventoryAdjustment = require('../../models/InventoryAdjustment');
const { decrypt } = require('../core/encryption');
const log = require('../core/logger')('AmazonInventoryPush');

/**
 * Push merchant-fulfilled quantity to Amazon Listings API (SP-API).
 * FBA SKUs are skipped — Amazon owns that inventory.
 */
async function pushAmazonInventoryInline({ clientId, sellerSku, quantity, sku, adjustmentId }) {
  const client = await Client.findOne({ clientId }).select('amazonConfig').lean();
  if (!client?.amazonConfig?.refreshToken) {
    return { ok: false, reason: 'amazon_not_connected' };
  }

  const creds = {
    ...client.amazonConfig,
    refreshToken: decrypt(client.amazonConfig.refreshToken),
    clientSecret: client.amazonConfig.lwaClientSecret
      ? decrypt(client.amazonConfig.lwaClientSecret)
      : process.env.AMAZON_CLIENT_SECRET,
    clientId: client.amazonConfig.lwaClientId || process.env.AMAZON_CLIENT_ID,
  };

  const api = new AmazonSPAPI(creds);
  const sellerId = client.amazonConfig.sellerId;
  const marketplaceId = client.amazonConfig.marketplaceId || 'A21TJ7DG3Y56XX';

  if (!sellerId) {
    return { ok: false, reason: 'missing_seller_id' };
  }

  const result = await api.updateListingQuantity({
    sellerId,
    marketplaceId,
    sellerSku,
    quantity: Math.max(0, Number(quantity) || 0),
  });

  if (adjustmentId && result.ok) {
    await InventoryAdjustment.updateOne({ _id: adjustmentId }, { $set: { syncStatus: 'synced' } });
  }

  if (!result.ok) {
    log.warn(`Amazon push failed ${clientId}/${sellerSku}: ${result.reason || result.error}`);
  }

  return result;
}

module.exports = { pushAmazonInventoryInline };
