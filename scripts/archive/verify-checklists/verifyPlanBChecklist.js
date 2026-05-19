#!/usr/bin/env node
/** Plan B static sign-off — hot GET routes use apiCache + perf hooks. */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', '..');
const checks = [
  ['templates list cache', 'routes/templates.js', "router.get('/list', protect, apiCache(60)"],
  ['knowledge GET cache', 'routes/knowledge.js', "router.get('/', protect, apiCache(60)"],
  ['segments list cache', 'routes/segments.js', "router.get('/', protect, apiCache(60)"],
  ['segments leads cache', 'routes/segments.js', "router.get('/:id/leads', protect, apiCache(45)"],
  ['signoff env helper', 'scripts/_lib/signoffEnv.js', 'BACKEND_ROOT'],
];

console.log('\n=== Plan B checklist ===\n');
let failed = 0;
for (const [label, file, needle] of checks) {
  const fp = path.join(root, file);
  const ok = fs.existsSync(fp) && fs.readFileSync(fp, 'utf8').includes(needle);
  console.log(ok ? '✅' : '❌', label);
  if (!ok) failed += 1;
}
process.exit(failed ? 1 : 0);
