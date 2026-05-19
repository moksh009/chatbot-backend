#!/usr/bin/env node
/**
 * Run performance phase checklists 5–11 in one command.
 * Usage: node scripts/verifyAllPhases.js
 */
const { spawnSync } = require('child_process');
const path = require('path');

const scripts = [
  'verifyPlanGChecklist.js',
  'verifyPlanFChecklist.js',
  'verifyPlanEChecklist.js',
  'verifyPlanDChecklist.js',
  'verifyPlanCChecklist.js',
  'verifyPlanBChecklist.js',
  'verifyPhase5Checklist.js',
  'verifyPhase6Checklist.js',
  'verifyPhase8Checklist.js',
  'verifyPhase9Checklist.js',
  'verifyPhase10Checklist.js',
  'verifyPhase11Checklist.js',
];

const dir = path.join(__dirname, 'archive/verify-checklists');
let failed = 0;

console.log('\n=== Verify all phases (5–11) ===\n');

for (const name of scripts) {
  const file = path.join(dir, name);
  if (!require('fs').existsSync(file)) {
    console.log('⏭️ ', name, '(missing)');
    continue;
  }
  console.log('---', name, '---');
  const r = spawnSync('node', [file], { cwd: path.join(dir, '..'), stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
}

console.log(failed ? `\n❌ ${failed} checklist(s) failed\n` : '\n✅ All checklists passed\n');
process.exit(failed ? 1 : 0);
