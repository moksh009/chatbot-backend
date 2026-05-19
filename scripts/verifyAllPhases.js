#!/usr/bin/env node
/**
 * Run performance phase checklists 5–11 in one command.
 * Usage: node scripts/verifyAllPhases.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const archiveScripts = [
  'verifyPlanGChecklist.js',
  'verifyPlanFChecklist.js',
  'verifyPlanEChecklist.js',
  'verifyPlanDChecklist.js',
  'verifyPlanCChecklist.js',
  'verifyPlanBChecklist.js',
  'verifyPhase5Checklist.js',
  'verifyPhase8Checklist.js',
  'verifyPhase9Checklist.js',
  'verifyPhase10Checklist.js',
  'verifyPhase11Checklist.js',
];

const rootScripts = ['verifyPhase6Checklist.js', 'verifyPhase7Checklist.js'];

const archiveDir = path.join(__dirname, 'archive/verify-checklists');
const scriptsRoot = __dirname;
let failed = 0;

console.log('\n=== Verify all phases (5–11) ===\n');

function runScript(file, name) {
  if (!require('fs').existsSync(file)) {
    console.log('⏭️ ', name, '(missing)');
    return;
  }
  console.log('---', name, '---');
  const r = spawnSync('node', [file], { cwd: scriptsRoot, stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}

for (const name of rootScripts) {
  runScript(path.join(scriptsRoot, name), name);
}
for (const name of archiveScripts) {
  runScript(path.join(archiveDir, name), name);
}

console.log(failed ? `\n❌ ${failed} checklist(s) failed\n` : '\n✅ All checklists passed\n');
process.exit(failed ? 1 : 0);
