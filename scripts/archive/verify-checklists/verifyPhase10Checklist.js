/**
 * Phase 10 — Leads + Templates sign-off (code structure).
 * Usage: node scripts/verifyPhase10Checklist.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../../../..');
const be = path.join(root, 'chatbot-backend-main');
const fe = path.join(root, 'chatbot-dashboard-frontend-main/src');

const checks = [
  ['leadsAnalyticsFacet $facet', path.join(be, 'utils/leadsAnalyticsFacet.js'), 'fetchLeadsAnalyticsBundle'],
  ['analytics/leads uses facet', path.join(be, 'routes/analytics.js'), 'fetchLeadsAnalyticsBundle'],
  ['high-intent baseQuery count', path.join(be, 'routes/leads.js'), 'HIGH_INTENT_BASE'],
  ['high-intent apiCache', path.join(be, 'routes/leads.js'), "apiCache(45)"],
  ['Leads useQuery', path.join(fe, 'pages/Leads.jsx'), "useQuery"],
  ['Leads placeholderData', path.join(fe, 'pages/Leads.jsx'), 'placeholderData'],
  ['useTemplatesQuery hook', path.join(fe, 'hooks/useTemplatesQuery.js'), 'templatesQueryKey'],
  ['TemplateManager useTemplatesQuery', path.join(fe, 'pages/TemplateManager.jsx'), 'useTemplatesQuery'],
];

console.log('\n=== Phase 10 Leads + Templates checklist ===\n');
let failed = 0;
for (const [label, filePath, needle] of checks) {
  const ok = fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(needle);
  console.log(ok ? '✅' : '❌', label);
  if (!ok) failed += 1;
}
console.log('\nManual: Audience hub → Leads tab → paginate/filter without duplicate fetches (React Query cache).\n');
process.exit(failed ? 1 : 0);
