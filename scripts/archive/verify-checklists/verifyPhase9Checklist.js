/**
 * Phase 9 — Hub pages sign-off (code structure + optional HTTP).
 * Usage: node scripts/verifyPhase9Checklist.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../../../..');
const fe = path.join(root, 'chatbot-dashboard-frontend-main/src');

const checks = [
  ['HubPage Component prop', path.join(fe, 'components/ui/HubPage.jsx'), 'tab.Component'],
  ['useHubTabActiveEffect', path.join(fe, 'hooks/useHubTabActive.js'), 'useHubTabActiveEffect'],
  ['MetaManagerHub lazy', path.join(fe, 'pages/MetaManagerHub.jsx'), 'lazy(() => import'],
  ['IntelligenceHub lazy', path.join(fe, 'pages/IntelligenceHub.jsx'), 'Component: IntentEngineTab'],
  ['AudienceHub lazy', path.join(fe, 'pages/AudienceHub.jsx'), 'Component: Leads'],
  ['CommerceHub lazy Shopify', path.join(fe, 'pages/CommerceHub.jsx'), 'lazy(() => import(\'./ShopifyHub\')'],
  ['MetaMessages hub guard', path.join(fe, 'pages/MetaMessagesWorkspace.jsx'), 'hubTabActive'],
  ['Leads hub guard', path.join(fe, 'pages/Leads.jsx'), 'hubTabActive'],
];

console.log('\n=== Phase 9 Hub checklist ===\n');
let failed = 0;
for (const [label, filePath, needle] of checks) {
  const ok = fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(needle);
  console.log(ok ? '✅' : '❌', label);
  if (!ok) failed += 1;
}

console.log('\nManual: open Meta Manager → switch tabs → Network tab should NOT refetch hidden tabs.');
console.log('Open Customers hub → only active tab API calls in Network.\n');
process.exit(failed ? 1 : 0);
