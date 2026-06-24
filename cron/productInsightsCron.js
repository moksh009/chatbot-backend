const cron = require('node-cron');
const log = require('../utils/core/logger')('ProductInsightsCron');
const { wrapCron } = require('../utils/core/perfLogger');
const { reconcileAllClientsProductStats } = require('../utils/commerce/productInsightsRollup');

function scheduleProductInsightsCron() {
  cron.schedule(
    '15 19 * * *',
    wrapCron('Product insights nightly reconciliation', async () => {
      log.info('Running product insights reconciliation (7d backfill)...');
      await reconcileAllClientsProductStats(7);
    })
  );
}

module.exports = scheduleProductInsightsCron;
