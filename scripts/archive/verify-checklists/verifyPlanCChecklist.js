#!/usr/bin/env node
/**
 * Plan C — Cron split + Mongo pool health sign-off.
 * Usage: node scripts/verifyPlanCChecklist.js [--baseUrl=http://localhost:5001]
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');
const baseUrl =
  process.argv.find((a) => a.startsWith('--baseUrl='))?.split('=')[1] ||
  process.env.API_BASE_URL ||
  'http://localhost:5001';

const staticChecks = [
  ['CRON_SCHEDULE.md', 'docs/CRON_SCHEDULE.md', 'Coordinator bundles'],
  ['start-api-dev RUN_CRONS=false', 'scripts/start-api-dev.sh', 'RUN_CRONS=false'],
  ['start-crons-only RUN_API=false', 'scripts/start-crons-only.sh', 'RUN_API=false'],
  ['wrapCron uses mongo budget', 'utils/perfLogger.js', 'acquireCronMongoSlot'],
  ['health mongoPool', 'controllers/HealthController.js', 'getMongoPoolStats'],
  ['health process flags', 'controllers/HealthController.js', 'healthStatus.process'],
  ['env CRON_USE_COORDINATOR', '.env.example', 'CRON_USE_COORDINATOR'],
];

console.log('\n=== Plan C checklist ===\n');
let failed = 0;

for (const [label, file, needle] of staticChecks) {
  const fp = path.join(root, file);
  const ok = fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').includes(needle);
  console.log(ok ? '✅' : '❌', label);
  if (!ok) failed += 1;
}

(async () => {
  const url = `${baseUrl.replace(/\/$/, '')}/api/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    const poolOk = body.mongoPool && body.mongoPool.configuredMaxPoolSize != null;
    const budgetOk = body.mongoCronBudget && body.mongoCronBudget.maxConcurrent != null;
    const processOk = body.process && typeof body.process.RUN_API === 'boolean';
    console.log(poolOk ? '✅' : '❌', 'GET /api/health mongoPool');
    console.log(budgetOk ? '✅' : '❌', 'GET /api/health mongoCronBudget');
    console.log(processOk ? '✅' : '❌', 'GET /api/health process flags');
    if (body.process?.RUN_CRONS === true && body.process?.RUN_API === true) {
      console.log('🟡', 'Server has RUN_API+RUN_CRONS — restart with ./scripts/start-api-dev.sh for UI work');
    } else if (body.process?.RUN_CRONS === false) {
      console.log('✅', 'Server is API-only (RUN_CRONS=false)');
    }
    if (!poolOk || !budgetOk || !processOk) failed += 1;
    if (body.warnings?.length) {
      console.log('🟡', 'Warnings:', body.warnings.join('; '));
    }
  } catch (e) {
    console.log('🟡', 'GET /api/health skipped —', e.message);
    console.log('   Start API: ./scripts/start-api-dev.sh');
  }

  console.log('\nManual: Terminal 1 = ./scripts/start-api-dev.sh | Terminal 2 = ./scripts/start-crons-only.sh\n');
  process.exit(failed ? 1 : 0);
})();
