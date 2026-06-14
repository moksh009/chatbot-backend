'use strict';

/**
 * Step 4 backend verification — all surfaces must match SSOT for same date range.
 * Usage: CLIENT_ID=topedgedemo_956281 node scripts/verify-step4-backend-parity.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { calculateRecoveryMetrics } = require('../services/cartRecoveryMetricsService');
const { buildAbandonedCartWorkspace } = require('../utils/commerce/abandonedCartWorkspace');
const { buildCommercePeriodKpis } = require('../utils/core/commercePeriodKpis');
const { buildRecoveredRevenueSummary } = require('../utils/hub/recoveredRevenueSummary');
const { getCartRecoveryChart } = require('../utils/core/dashboardChartAnalytics');
const { computeSevenDayRecoveryRate } = require('../cron/cartRecoveryRateAlertCron');
const { rebuildCache } = require('../utils/core/statCacheEngine');
const { istDateRangeStrings, startOfDayForDateStrIST } = require('../utils/core/queryHelpers');

const CLIENT_ID = process.env.CLIENT_ID || 'topedgedemo_956281';
const DAYS = Number(process.env.DAYS) || 30;

async function storeEconomicsCartRecovery(clientId, from, to) {
  const { calculateRecoveryMetrics: calc } = require('../services/cartRecoveryMetricsService');
  const metrics = await calc(clientId, { mode: 'cohort', from, to, includeFunnel: true });
  return {
    recoveredCarts: metrics.recoveredCarts,
    revenueRecovered: metrics.revenueRecovered,
    recoveryRate: metrics.recoveryRate,
  };
}

async function analyticsFunnelRecovery(clientId, from, to) {
  const metrics = await calculateRecoveryMetrics(clientId, {
    mode: 'cohort',
    from,
    to,
    includeFunnel: true,
  });
  return {
    recoveredCarts: metrics.recoveredCarts,
    revenueRecovered: metrics.revenueRecovered,
    recoveryRate: metrics.recoveryRate,
  };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { start } = istDateRangeStrings(DAYS);
  const from = startOfDayForDateStrIST(start);
  const to = new Date();

  const ssot = await calculateRecoveryMetrics(CLIENT_ID, { from, to, includeFunnel: true });
  const expected = {
    recoveredCarts: ssot.recoveredCarts,
    revenueRecovered: ssot.revenueRecovered,
    recoveryRate: ssot.recoveryRate,
  };

  const [workspace, periodKpis, recoveredSummary, chart, storeEcon, funnel, cache] =
    await Promise.all([
      buildAbandonedCartWorkspace(CLIENT_ID, { preset: `${DAYS}d` }),
      buildCommercePeriodKpis({ clientId: CLIENT_ID, days: DAYS }),
      buildRecoveredRevenueSummary(CLIENT_ID, { days: DAYS }),
      getCartRecoveryChart(CLIENT_ID, `${DAYS}d`),
      storeEconomicsCartRecovery(CLIENT_ID, from, to),
      analyticsFunnelRecovery(CLIENT_ID, from, to),
      rebuildCache(CLIENT_ID),
    ]);

  const surfaces = [
    ['A: /api/cart-recovery/metrics (SSOT)', expected],
    [
      'B: abandoned-carts/workspace',
      {
        recoveredCarts: workspace.metrics.recoveredCarts,
        revenueRecovered: workspace.metrics.revenueRecovered,
        recoveryRate: workspace.metrics.recoveryRate,
      },
    ],
    [
      'C: commercePeriodKpis',
      {
        recoveredCarts: periodKpis.recoveredCarts,
        revenueRecovered: periodKpis.revenueRecovered,
        recoveryRate: periodKpis.recoveryRate,
      },
    ],
    [
      'D: recovered-summary',
      {
        recoveredCarts: recoveredSummary.cartRecovery.recoveredCarts,
        revenueRecovered: recoveredSummary.revenueRecovered,
        recoveryRate: recoveredSummary.recoveryRate,
      },
    ],
    [
      'E: cart-recovery-chart',
      {
        recoveredCarts: chart.summary.totalRecovered,
        revenueRecovered: null,
        recoveryRate: chart.summary.recoveryRate,
      },
    ],
    ['F: store-economics/cart-recovery', storeEcon],
    ['G: analytics/funnel recovery', funnel],
    [
      'H: statCache (30d cohort)',
      {
        recoveredCarts: cache?.recoveredCarts,
        revenueRecovered: null,
        recoveryRate: null,
      },
    ],
  ];

  console.log(`\nStep 4 backend parity — ${CLIENT_ID} — last ${DAYS} days\n`);
  console.log('SSOT:', expected, '\n');

  let pass = true;
  for (const [name, got] of surfaces) {
    const rc = got.recoveredCarts === expected.recoveredCarts;
    const rev = got.revenueRecovered == null || got.revenueRecovered === expected.revenueRecovered;
    const rate = got.recoveryRate == null || got.recoveryRate === expected.recoveryRate;
    const ok = rc && rev && rate;
    if (!ok) pass = false;
    console.log(
      `${ok ? 'OK' : 'FAIL'} ${name}`,
      JSON.stringify(got)
    );
  }

  const alert = await computeSevenDayRecoveryRate(CLIENT_ID);
  console.log(
    `\nAlert cron (7d): rate=${alert.rate}% recovered=${alert.recovered} abandoned=${alert.totalAbandoned}`
  );

  console.log(`\nResult: ${pass ? 'PASS' : 'FAIL'}\n`);
  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
