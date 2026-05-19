#!/usr/bin/env node
/**
 * Plan G — Production sign-off (split deploy docs, qa:ci, health smoke).
 *
 * Usage:
 *   node scripts/verifyPlanGChecklist.js
 *   node scripts/verifyPlanGChecklist.js --run-qa
 *   node scripts/verifyPlanGChecklist.js --baseUrl=http://localhost:5001
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..', '..', '..');
const workspaceRoot = path.join(root, '..');
const feRoot = path.join(workspaceRoot, 'chatbot-dashboard-frontend-main');
const runQa = process.argv.includes('--run-qa');
const baseUrl =
  process.argv.find((a) => a.startsWith('--baseUrl='))?.split('=')[1] ||
  process.env.API_BASE_URL ||
  'http://localhost:5001';

const staticChecks = [
  ['PRODUCTION_SIGNOFF.md', 'docs/PRODUCTION_SIGNOFF.md', 'Split processes'],
  ['PHASE5_DEPLOY split table', 'docs/PHASE5_DEPLOY.md', 'RUN_CRONS=false'],
  ['backend qa:ci script', 'package.json', '"qa:ci"'],
  ['frontend qa:ci script', null, null], // checked via feRoot below
  ['start-api-dev.sh', 'scripts/start-api-dev.sh', 'RUN_CRONS=false'],
  ['start-crons-only.sh', 'scripts/start-crons-only.sh', 'RUN_API=false'],
  ['health mongoPool', 'controllers/HealthController.js', 'mongoPool'],
  ['.env.example split flags', '.env.example', 'RUN_CRONS=false'],
  ['load smoke k6 script', 'package.json', 'load-smoke:k6'],
];

function getNpmScript(pkgPath, scriptName) {
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).scripts?.[scriptName];
}

console.log('\n=== Plan G checklist ===\n');
let failed = 0;

for (const [label, file, needle] of staticChecks) {
  if (!file) continue;
  const fp = path.join(root, file);
  const ok = fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').includes(needle);
  console.log(ok ? '✅' : '❌', label);
  if (!ok) failed += 1;
}

const fePkg = path.join(feRoot, 'package.json');
const fePkgOk = fs.existsSync(fePkg) && fs.readFileSync(fePkg, 'utf8').includes('"qa:ci"');
console.log(fePkgOk ? '✅' : '❌', 'frontend qa:ci script');
if (!fePkgOk) failed += 1;

const beQa = getNpmScript(path.join(root, 'package.json'), 'qa:ci');
const feQa = fePkgOk ? getNpmScript(fePkg, 'qa:ci') : null;
console.log(beQa ? '✅' : '❌', 'backend qa:ci command defined');
console.log(feQa ? '✅' : '❌', 'frontend qa:ci command defined');
if (!beQa || !feQa) failed += 1;

if (runQa) {
  console.log('\n--- Running backend npm run qa:ci ---\n');
  const be = spawnSync('npm', ['run', 'qa:ci'], { cwd: root, stdio: 'inherit', shell: true });
  if (be.status !== 0) {
    console.log('❌ backend qa:ci failed');
    failed += 1;
  } else {
    console.log('✅ backend qa:ci passed');
  }

  console.log('\n--- Running frontend npm run qa:ci ---\n');
  const fe = spawnSync('npm', ['run', 'qa:ci'], { cwd: feRoot, stdio: 'inherit', shell: true });
  if (fe.status !== 0) {
    console.log('❌ frontend qa:ci failed');
    failed += 1;
  } else {
    console.log('✅ frontend qa:ci passed');
  }
} else {
  console.log('\n🟡', 'Skip CI run (pass --run-qa to execute backend + frontend qa:ci)');
}

(async () => {
  const url = `${baseUrl.replace(/\/$/, '')}/api/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    const ok = res.ok && body.mongoPool != null;
    console.log(ok ? '✅' : '❌', 'GET /api/health reachable');
    if (body.process?.RUN_API === true && body.process?.RUN_CRONS === true) {
      console.log('🟡', 'Production warning: same process has RUN_API+RUN_CRONS — split web/worker dynos');
    } else if (body.process?.RUN_CRONS === false) {
      console.log('✅', 'Health: API-only mode (good for web dyno)');
    }
    if (!ok) failed += 1;
  } catch (e) {
    console.log('🟡', 'GET /api/health skipped —', e.message);
  }

  console.log('\nManual: see docs/PRODUCTION_SIGNOFF.md\n');
  process.exit(failed ? 1 : 0);
})();
