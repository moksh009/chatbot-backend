/**
 * Runs all Phase 4 sign-off scripts and prints a checklist summary.
 * Usage: node scripts/verifyPhase4Checklist.js [--clientId=delitech_smarthomes] [--skipSend]
 */
const { spawnSync } = require('child_process');
const path = require('path');

const clientId =
  process.argv.find((a) => a.startsWith('--clientId='))?.split('=')[1] || 'delitech_smarthomes';
const skipSend = process.argv.includes('--skipSend');
const root = path.join(__dirname, '..');

function run(script, extraArgs = []) {
  const args = [path.join(__dirname, script), `--clientId=${clientId}`, ...extraArgs];
  const r = spawnSync('node', args, { cwd: root, encoding: 'utf8', timeout: 120000 });
  return {
    script,
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

const steps = [
  ['verifyLiveChat4A.js', []],
  ['archive/signoff/signoff4AHttp.js', skipSend ? ['--skipSend'] : []],
  ['archive/signoff/signoff4BHttp.js', []],
  ['archive/signoff/signoff4C.js', []],
  ['archive/verify-checklists/verifyPhase3Rollup.js', []],
];

console.log(`\n=== Phase 4 checklist (clientId=${clientId}) ===\n`);
const results = [];
for (const [script, args] of steps) {
  const r = run(script, args);
  results.push(r);
  console.log(`${r.ok ? '✅' : '❌'} ${script}`);
  if (r.stdout) console.log(r.stdout.split('\n').slice(-8).join('\n'));
  if (!r.ok && r.stderr) console.log(r.stderr.split('\n').slice(-3).join('\n'));
  console.log('');
}

const failed = results.filter((r) => !r.ok);
process.exit(failed.length ? 1 : 0);
