#!/usr/bin/env node
'use strict';

/**
 * Load test helper for cart cron fairness (Phase 7).
 * Simulates round-robin over N synthetic tenant IDs — no DB writes.
 *
 * Usage: node scripts/load-test-cart-cron-fairness.js [tenantCount] [batchSize] [ticks]
 */

const { CURSOR_KEY } = require('../utils/commerce/cartCronFairness');

function simulateFairness(tenantCount, batchSize, ticks) {
  const ids = Array.from({ length: tenantCount }, (_, i) => `tenant_${String(i).padStart(4, '0')}`);
  let cursor = 0;
  const served = new Map(ids.map((id) => [id, 0]));

  for (let t = 0; t < ticks; t += 1) {
    for (let i = 0; i < Math.min(batchSize, ids.length); i += 1) {
      const id = ids[(cursor + i) % ids.length];
      served.set(id, (served.get(id) || 0) + 1);
    }
    cursor = (cursor + Math.min(batchSize, ids.length)) % ids.length;
  }

  const counts = [...served.values()];
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  const spread = max - min;

  return { tenantCount, batchSize, ticks, cursorKey: CURSOR_KEY, min, max, spread, served: Object.fromEntries(served) };
}

const tenantCount = parseInt(process.argv[2], 10) || 100;
const batchSize = parseInt(process.argv[3], 10) || 40;
const ticks = parseInt(process.argv[4], 10) || 25;

const result = simulateFairness(tenantCount, batchSize, ticks);
console.log(JSON.stringify(result, null, 2));

if (result.spread > 1) {
  console.error(`FAIL: fairness spread ${result.spread} > 1`);
  process.exit(1);
}
console.log('OK: fair round-robin within 1 tick spread');
