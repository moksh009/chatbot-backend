#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const routesDir = path.join(ROOT, 'routes');
const out = path.join(ROOT, 'docs/phase-6/ROUTE_PERMISSIONS_FULL.md');

const PUBLIC_FILES = new Set([
  'auth.js',
  'publicUnsubscribe.js',
  'publicGrowth.js',
  'publicWarranty.js',
  'checkoutConsent.js',
  'shopifyWebhook.js',
  'shopifyComplianceWebhooks.js',
  'masterWebhook.js',
  'razorpayWebhook.js',
  'emailWebhook.js',
  'intentWebhooks.js',
  'dynamicClientRouter.js',
  'tracking.js',
  'checkoutShortLink.js',
  '_devWebhookTest.js',
]);

const lines = ['# Phase 6 — Full Route Permissions Catalog', '', '| File | Method | Path | Scope | Role |', '|---|---|---|---|---|'];

for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js')).sort()) {
  const src = fs.readFileSync(path.join(routesDir, file), 'utf8');
  const re = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi;
  let m;
  const isPublic = PUBLIC_FILES.has(file);
  while ((m = re.exec(src))) {
    const method = m[1].toUpperCase();
    const p = m[2];
    let scope = isPublic ? 'publicRoute' : 'protect→autoTenantScope';
    let role = isPublic ? '—' : method === 'GET' ? 'read' : 'mutate/inbox';
    if (p.includes(':clientId')) scope += ' (param clientId)';
    if (/:id|:leadId|:sequenceId/.test(p)) scope += ' (resource lookup)';
    if (/conversations.*messages/i.test(p)) role = 'inbox_send';
    if (file === 'admin.js') role = 'authorize + SUPER_ADMIN paths';
    lines.push(`| ${file} | ${method} | ${p} | ${scope} | ${role} |`);
  }
}

lines.push('', '_Global: all `protect` routes chain `autoTenantScope` + `roleForMethod` (Phase 6)._');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join('\n'));
console.log(`Wrote ${lines.length - 4} routes to ${out}`);
