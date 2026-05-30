'use strict';

const cron = require('node-cron');
const Client = require('../models/Client');
const log = require('../utils/core/logger')('ShopifyTokenRefreshCron');
const { wrapCron } = require('../utils/core/perfLogger');
const { refreshShopifyAccessToken } = require('../utils/shopify/shopifyConnectionHeal');

/**
 * Proactively refresh Shopify expiring offline access tokens before they lapse.
 * Required for embedded app / OAuth installs (Shopify 2026 expiring token policy).
 */
function registerShopifyTokenRefreshCron() {
  cron.schedule(
    '*/15 * * * *',
    wrapCron('Shopify token refresh', async () => {
      const soon = new Date(Date.now() + 45 * 60 * 1000);
      const clients = await Client.find({
        shopifyConnectionStatus: { $in: ['connected', 'error'] },
        shopifyRefreshToken: { $exists: true, $ne: '' },
        shopifyTokenExpiresAt: { $lte: soon },
        shopDomain: { $exists: true, $ne: '' },
      })
        .select('clientId shopDomain shopifyTokenExpiresAt')
        .limit(50)
        .lean();

      if (!clients.length) return;

      log.info(`Refreshing Shopify tokens for ${clients.length} workspace(s)`);
      for (const c of clients) {
        try {
          await refreshShopifyAccessToken(c.clientId, { force: false });
        } catch (err) {
          log.warn('Shopify refresh failed', { clientId: c.clientId, message: err.message });
        }
      }
    })
  );
  log.info('Shopify token refresh cron registered (every 15 min)');
}

module.exports = { registerShopifyTokenRefreshCron };
