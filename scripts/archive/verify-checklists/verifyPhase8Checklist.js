/**
 * Phase 8 — Analytics + WhatsApp greeting sign-off hints.
 * Usage: node scripts/archive/verify-checklists/verifyPhase8Checklist.js [--clientId=delitech_smarthomes]
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const clientId =
  process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';
const root = path.join(__dirname, '..', '..', '..');
const analyticsJs = path.join(root, 'routes/analytics.js');
const analyticsFe = path.join(root, '..', 'chatbot-dashboard-frontend-main', 'src/pages/Analytics.jsx');

console.log(`\n=== Phase 8 checklist (${clientId}) ===\n`);

const phase6 = spawnSync(
  'node',
  [path.join(root, 'scripts/verifyPhase6Checklist.js'), `--clientId=${clientId}`],
  { cwd: root, encoding: 'utf8', timeout: 120000 }
);
console.log(phase6.status === 0 ? '✅' : '❌', 'Phase 6 Orders (static regression)');
if (phase6.stdout) console.log(phase6.stdout.trim().split('\n').slice(-4).join('\n'));

let failed = phase6.status !== 0 ? 1 : 0;

function check(label, ok) {
  console.log(ok ? '✅' : '❌', label);
  if (!ok) failed += 1;
}

if (fs.existsSync(analyticsJs)) {
  const src = fs.readFileSync(analyticsJs, 'utf8');
  check('overview-bundle route', /\/overview-bundle['"],\s*protect,\s*apiCache/.test(src));
  check('overview-bundle dedupe', /analytics:overview:/.test(src));
  check('flow-heatmap apiCache', /\/flow-heatmap['"],\s*protect,\s*apiCache/.test(src));
}
if (fs.existsSync(analyticsFe)) {
  const src = fs.readFileSync(analyticsFe, 'utf8');
  check('Analytics overview-bundle first paint', /overview-bundle/.test(src));
}

console.log('\nPhase 8 backend (restart API to pick up routes):');
console.log('  GET /api/analytics/overview-bundle?days=30&clientId=' + clientId);
console.log('  GET /api/analytics/insights?days=30 (bounded, cached)\n');

console.log('Phase 8B WhatsApp greeting (manual):');
console.log('  1. RUN_CRONS=false API: ./scripts/start-api-dev.sh');
console.log('  2. Send "hi" on WhatsApp');
console.log('  3. Expect: read receipt + reply <3s; log: message_saved_early, flow_match_greeting OR greeting_instant_fallback\n');

process.exit(failed ? 1 : 0);
