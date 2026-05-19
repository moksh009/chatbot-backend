/**
 * Phase 11 — Settings + Campaign sign-off (code structure).
 * Usage: node scripts/verifyPhase11Checklist.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../../../..');
const be = path.join(root, 'chatbot-backend-main');
const fe = path.join(root, 'chatbot-dashboard-frontend-main/src');

const checks = [
  ['Settings lazy panels', path.join(fe, 'pages/Settings.jsx'), 'lazy(() => import'],
  ['automation health gated', path.join(fe, 'pages/Settings.jsx'), 'automationHealthEnabled'],
  ['Settings refetch on clientId', path.join(fe, 'pages/Settings.jsx'), '[clientId]'],
  ['Campaign estimate debounce', path.join(fe, 'pages/CampaignManager.jsx'), 'setTimeout(async'],
  ['my-settings clearClientCache', path.join(be, 'routes/admin.js'), 'clearClientCache(targetClientId)'],
  ['config patch clearClientCache', path.join(be, 'routes/dynamicClientRouter.js'), 'clearClientCache(clientId)'],
  ['campaign overview apiCache', path.join(be, 'routes/campaigns.js'), "apiCache(60)"],
  ['audience-estimate apiCache', path.join(be, 'routes/campaigns.js'), "apiCache(30)"],
];

console.log('\n=== Phase 11 Settings + Campaign checklist ===\n');
let failed = 0;
for (const [label, filePath, needle] of checks) {
  const ok = fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(needle);
  console.log(ok ? '✅' : '❌', label);
  if (!ok) failed += 1;
}
console.log('\nManual: save Settings → refresh dashboard; open Campaign builder → change audience without estimate spam.\n');
process.exit(failed ? 1 : 0);
