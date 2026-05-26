'use strict';

const cron = require('node-cron');
const log = require('../utils/core/logger')('InventoryCrons');
const { wrapCron } = require('../utils/core/perfLogger');

function registerInventoryCrons() {
  if (process.env.CRON_ENABLE_INVENTORY === 'false') {
    log.info('Inventory crons disabled (CRON_ENABLE_INVENTORY=false)');
    return;
  }

  const scheduleAmazonSync = require('./amazonSync');
  if (typeof scheduleAmazonSync === 'function') scheduleAmazonSync();

  cron.schedule(
    '0 3 * * *',
    wrapCron('Inventory reconciliation', async () => {
      const { runReconciliationForAllClients } = require('../utils/inventory/reconciliation');
      await runReconciliationForAllClients();
    }),
    { timezone: 'Asia/Kolkata' }
  );

  cron.schedule('*/50 * * * *', wrapCron('Amazon LWA token refresh', async () => {
    const Client = require('../models/Client');
    const AmazonSPAPI = require('../utils/commerce/amazonSPAPI');
    const { decrypt } = require('../utils/core/encryption');

    const clients = await Client.find({ 'amazonConfig.refreshToken': { $exists: true, $ne: '' } })
      .select('clientId amazonConfig')
      .lean();

    for (const c of clients) {
      try {
        const api = new AmazonSPAPI({
          refreshToken: decrypt(c.amazonConfig.refreshToken),
          clientId: c.amazonConfig.lwaClientId || process.env.AMAZON_CLIENT_ID,
          clientSecret: c.amazonConfig.lwaClientSecret
            ? decrypt(c.amazonConfig.lwaClientSecret)
            : process.env.AMAZON_CLIENT_SECRET,
          region: c.amazonConfig.region,
        });
        await api.getAccessToken();
        await Client.updateOne(
          { clientId: c.clientId },
          {
            $set: {
              'amazonConfig.lastTokenRefreshAt': new Date(),
              'amazonConfig.needsReauth': false,
            },
          }
        );
      } catch (err) {
        await Client.updateOne(
          { clientId: c.clientId },
          { $set: { 'amazonConfig.needsReauth': true } }
        );
        log.warn(`Amazon token refresh failed ${c.clientId}: ${err.message}`);
      }
    }
  }));

  cron.schedule(
    '0 6 * * *',
    wrapCron('Restock suggestions', async () => {
      const Client = require('../models/Client');
      const { generateRestockSuggestions } = require('../utils/inventory/restockSuggestionEngine');
      const { createDraftPoFromSuggestion } = require('../utils/inventory/restockSuggestionEngine');
      const RestockRule = require('../models/RestockRule');
      const clients = await Client.find({ isActive: true }).select('clientId').lean();
      for (const c of clients) {
        try {
          const suggestions = await generateRestockSuggestions(c.clientId);
          for (const s of suggestions.filter((x) => x.urgency === 'critical').slice(0, 3)) {
            const rule = await RestockRule.findOne({ clientId: c.clientId, sku: s.sku }).lean();
            if (rule?.autoCreateDraft && s.preferredSupplier?.id) {
              await createDraftPoFromSuggestion(c.clientId, s).catch(() => {});
            }
          }
        } catch (e) {
          log.warn(`Restock suggestions failed ${c.clientId}: ${e.message}`);
        }
      }
    }),
    { timezone: 'Asia/Kolkata' }
  );

  log.info('Inventory crons registered (Amazon sync, reconciliation 3am IST, token refresh, restock 6am IST)');
}

module.exports = { registerInventoryCrons };
