#!/usr/bin/env node
/**
 * Plan F — Docs index, scripts index, build artifacts gitignored.
 * Usage: node scripts/verifyPlanFChecklist.js
 */
const fs = require('fs');
const path = require('path');

const backendRoot = path.join(__dirname, '..', '..', '..');
const workspaceRoot = path.join(backendRoot, '..');

const checks = [
  {
    label: 'docs/README links MASTER',
    ok: () => {
      const md = fs.readFileSync(path.join(backendRoot, 'docs/README.md'), 'utf8');
      return md.includes('MASTER_SYSTEM_PLAN') && md.includes('PERFORMANCE_ROADMAP') && md.includes('PHASE5_DEPLOY');
    },
  },
  {
    label: 'docs/README links audit report',
    ok: () => fs.readFileSync(path.join(backendRoot, 'docs/README.md'), 'utf8').includes('SYSTEM_AUDIT_REPORT'),
  },
  {
    label: 'scripts/README lists verifyAllPhases',
    ok: () => fs.readFileSync(path.join(backendRoot, 'scripts/README.md'), 'utf8').includes('verifyAllPhases'),
  },
  {
    label: 'scripts/README lists verify-checklists archive',
    ok: () => {
      const md = fs.readFileSync(path.join(backendRoot, 'scripts/README.md'), 'utf8');
      return md.includes('verify-checklists') && md.includes('verifyAllPhases');
    },
  },
  {
    label: 'archive/README exists',
    ok: () => fs.existsSync(path.join(backendRoot, 'scripts/archive/README.md')),
  },
  {
    label: 'frontend dist/ gitignored',
    ok: () => fs.readFileSync(path.join(workspaceRoot, 'chatbot-dashboard-frontend-main/.gitignore'), 'utf8').includes('dist/'),
  },
  {
    label: 'backend perf_*.log gitignored',
    ok: () => fs.readFileSync(path.join(backendRoot, '.gitignore'), 'utf8').includes('perf_*.log'),
  },
  {
    label: 'marketing-site dist/ gitignored',
    ok: () => {
      const gi = path.join(workspaceRoot, 'marketing-site/.gitignore');
      return fs.existsSync(gi) && fs.readFileSync(gi, 'utf8').includes('dist/');
    },
  },
  {
    label: 'no committed perf_*.log in backend',
    ok: () => {
      const walk = (dir) => {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const p = path.join(dir, e.name);
          if (e.isDirectory() && e.name !== 'node_modules') return walk(p);
          if (e.isFile() && /^perf_.*\.log$/i.test(e.name)) return [p];
          return [];
        });
      };
      return walk(backendRoot).length === 0;
    },
  },
];

console.log('\n=== Plan F checklist ===\n');
let failed = 0;
for (const { label, ok } of checks) {
  const pass = ok();
  console.log(pass ? '✅' : '❌', label);
  if (!pass) failed += 1;
}
console.log('\nOptional: remove tracked marketing-site/dist if it was ever committed: git rm -r --cached marketing-site/dist\n');
process.exit(failed ? 1 : 0);
