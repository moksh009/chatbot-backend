/**
 * Phase 8 — Analytics + WhatsApp greeting sign-off hints.
 * Usage: node scripts/verifyPhase8Checklist.js [--clientId=delitech_smarthomes]
 */
const { spawnSync } = require('child_process');
const path = require('path');

const clientId =
  process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';
const baseUrl =
  process.argv.find((a) => a.startsWith('--baseUrl='))?.split('=')[1] ||
  process.env.API_BASE_URL ||
  'http://localhost:5001';
const root = path.join(__dirname, '..', '..', '..');

console.log(`\n=== Phase 8 checklist (${clientId}) ===\n`);

const phase6 = spawnSync('node', [path.join(__dirname, '../../verifyPhase6Checklist.js'), `--clientId=${clientId}`], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120000,
});
console.log(phase6.status === 0 ? '✅' : '❌', 'Phase 6 Orders (regression)');
if (phase6.stdout) console.log(phase6.stdout.trim().split('\n').slice(-4).join('\n'));

console.log('\nPhase 8 backend (restart API to pick up routes):');
console.log('  GET /api/analytics/overview-bundle?days=30&clientId=' + clientId);
console.log('  GET /api/analytics/insights?days=30 (bounded, cached)\n');

console.log('Phase 8B WhatsApp greeting (manual):');
console.log('  1. RUN_CRONS=false API: ./scripts/start-api-dev.sh');
console.log('  2. Send "hi" on WhatsApp');
console.log('  3. Expect: read receipt + reply <3s; log: message_saved_early, flow_match_greeting OR greeting_instant_fallback\n');

process.exit(phase6.status === 0 ? 0 : 1);
