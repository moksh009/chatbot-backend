'use strict';

/**
 * Step 3 parity check: workspace metrics vs canonical service.
 * Usage: CLIENT_ID=topedgedemo_956281 node scripts/verify-cart-recovery-metrics-parity.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { buildAbandonedCartWorkspace } = require('../utils/commerce/abandonedCartWorkspace');
const { calculateRecoveryMetrics } = require('../services/cartRecoveryMetricsService');

const CLIENT_ID = process.env.CLIENT_ID || 'topedgedemo_956281';
const PRESET = process.env.PRESET || '30d';

const FIELDS = [
  'totalAbandoned',
  'recoveredCarts',
  'revenueRecovered',
  'recoveryRate',
  'organicRecovered',
  'whatsappRecovered',
  'organicRevenue',
  'revenueRecoveredFromWhatsapp',
  'averageAbandonedCartValue',
];

function pickMetrics(ws) {
  return {
    totalAbandoned: ws.metrics.totalAbandoned,
    recoveredCarts: ws.metrics.recoveredCarts,
    revenueRecovered: ws.metrics.revenueRecovered,
    recoveryRate: ws.metrics.recoveryRate,
    organicRecovered: ws.metrics.organicRecovered,
    whatsappRecovered: ws.metrics.recoveredFromWhatsapp,
    organicRevenue: ws.metrics.organicRevenue,
    revenueRecoveredFromWhatsapp: ws.metrics.revenueRecoveredFromWhatsapp,
    averageAbandonedCartValue: ws.metrics.averageAbandonedCartValue,
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`\nParity check — clientId=${CLIENT_ID} preset=${PRESET}\n`);

  const workspace = await buildAbandonedCartWorkspace(CLIENT_ID, { preset: PRESET });
  const wsMetrics = pickMetrics(workspace);

  const endpoint = await calculateRecoveryMetrics(CLIENT_ID, {
    from: workspace.range.from,
    to: workspace.range.to,
    mode: 'cohort',
    includeFunnel: true,
    includeRows: false,
    reconcileFirst: true,
    persistOrderMap: true,
  });

  const epMetrics = {};
  for (const f of FIELDS) epMetrics[f] = endpoint[f];

  let pass = true;
  console.log('Field                          | Workspace      | Metrics API    | Match');
  console.log('-------------------------------|----------------|----------------|------');
  for (const f of FIELDS) {
    const a = wsMetrics[f];
    const b = epMetrics[f];
    const match = a === b;
    if (!match) pass = false;
    console.log(
      `${f.padEnd(30)} | ${String(a).padStart(14)} | ${String(b).padStart(14)} | ${match ? 'OK' : 'FAIL'}`
    );
  }

  const funnelFields = ['msg1Sent', 'msg2Sent', 'msg3Sent', 'recoveredAfterMsg1', 'recoveredAfterMsg2', 'recoveredAfterMsg3'];
  console.log('\nFunnel:');
  for (const f of funnelFields) {
    const a = workspace.funnel[f];
    const b = endpoint.funnel[f];
    const match = a === b;
    if (!match) pass = false;
    console.log(
      `${f.padEnd(30)} | ${String(a).padStart(14)} | ${String(b).padStart(14)} | ${match ? 'OK' : 'FAIL'}`
    );
  }

  console.log(`\nResult: ${pass ? 'PASS — all metrics match' : 'FAIL — divergence detected'}\n`);
  await mongoose.disconnect();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
