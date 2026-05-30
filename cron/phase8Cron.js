'use strict';

const cron = require('node-cron');
const log = require('../utils/core/logger')('Phase8Cron');
const { wrapCron } = require('../utils/core/perfLogger');

function registerPhase8Crons() {
  const { recomputeAllLeadPredictions } = require('../services/predictive/heuristic');
  cron.schedule(
    '30 2 * * *',
    wrapCron('predictive_nightly', async () => {
      const n = await recomputeAllLeadPredictions({ limit: 5000 });
      log.info(`Predictive recompute: ${n} leads`);
    }),
    { timezone: 'Asia/Kolkata' }
  );

  const { rollupDailyTenantCosts } = require('../services/billing/dailyCostRollup');
  cron.schedule(
    '15 1 * * *',
    wrapCron('daily_cost_rollup', async () => {
      const n = await rollupDailyTenantCosts();
      log.info(`Daily cost rollup: ${n} tenants`);
    }),
    { timezone: 'Asia/Kolkata' }
  );

  log.info('Phase 8 crons registered (predictive nightly, cost daily)');
}

module.exports = { registerPhase8Crons };
