'use strict';

const cron = require('node-cron');
const log = require('../utils/core/logger')('OptInAnalyticsRollupCron');
const { wrapCron } = require('../utils/core/perfLogger');
const { rollupOptInAnalyticsAllClients } = require('../services/optInAnalyticsService');

/**
 * Prunes impression/signup byDay maps older than 90 days (totals unchanged).
 * IST 04:30 daily = UTC 23:00 previous day.
 */
function scheduleOptInAnalyticsRollupCron() {
  cron.schedule(
    '0 23 * * *',
    wrapCron('OptIn analytics rollup', async () => {
      const result = await rollupOptInAnalyticsAllClients();
      log.info('Opt-in analytics rollup complete', result);
    })
  );
  log.info('Opt-in analytics rollup cron registered (04:30 IST daily)');
}

module.exports = scheduleOptInAnalyticsRollupCron;
