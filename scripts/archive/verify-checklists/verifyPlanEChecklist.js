#!/usr/bin/env node
/**
 * Plan E — Frontend dedupe (shared templates query, hub guards, dist gitignore).
 * Usage: node scripts/verifyPlanEChecklist.js
 */
const fs = require('fs');
const path = require('path');

const feRoot = path.join(__dirname, '..', '..', '..', '..', 'chatbot-dashboard-frontend-main');

const staticChecks = [
  ['useTemplatesQuery hook', 'src/hooks/useTemplatesQuery.js', 'useTemplatesQuery'],
  ['TemplateManager uses hook', 'src/pages/TemplateManager.jsx', 'useTemplatesQuery'],
  ['FlowBuilder uses hook', 'src/pages/FlowBuilder.jsx', 'useTemplatesQuery'],
  ['Campaign uses hook', 'src/pages/CampaignManager.jsx', 'useTemplatesQuery'],
  ['Settings notifications hook', 'src/pages/Settings.jsx', 'useTemplatesQuery'],
  ['Campaign hub tab guard', 'src/pages/CampaignManager.jsx', 'useHubTabActive'],
  ['FlowBuilder no deferred tpl fetch', 'src/pages/FlowBuilder.jsx', 'setTimeout(() => {\n          api\n            .get(`/templates/list'],
  ['dist gitignored', '.gitignore', 'dist/'],
];

console.log('\n=== Plan E checklist ===\n');
let failed = 0;

for (const [label, file, needle] of staticChecks) {
  const fp = path.join(feRoot, file);
  const content = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  const ok =
    label === 'FlowBuilder no deferred tpl fetch'
      ? fs.existsSync(fp) && !content.includes('setTimeout(() => {\n          api\n            .get(`/templates/list')
      : fs.existsSync(fp) && content.includes(needle);
  console.log(ok ? '✅' : '❌', label);
  if (!ok) failed += 1;
}

console.log('\nManual: open Marketing Hub → Campaigns + Flow Builder — Network tab should show one /templates/list per contextPurpose.\n');
process.exit(failed ? 1 : 0);
