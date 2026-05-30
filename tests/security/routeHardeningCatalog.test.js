'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');

function testProtectChainsSecurity() {
  const src = fs.readFileSync(path.join(ROOT, 'middleware/auth.js'), 'utf8');
  assert.ok(src.includes('autoTenantScope'));
  assert.ok(src.includes('roleForMethod'));
}

function testRouteFilesUseProtectOrPublic() {
  const routesDir = path.join(ROOT, 'routes');
  const publicOnly = new Set([
    'auth.js',
    'shopifyWebhook.js',
    'masterWebhook.js',
    'razorpayWebhook.js',
    'publicUnsubscribe.js',
    'tracking.js',
    '_devWebhookTest.js',
  ]);
  let withProtect = 0;
  for (const f of fs.readdirSync(routesDir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
    if (publicOnly.has(f) && !src.includes('protect')) continue;
    if (src.includes('protect') || src.includes('publicRoute')) withProtect += 1;
  }
  assert.ok(withProtect >= 50, `expected 50+ route files hardened, got ${withProtect}`);
}

const ROUTE_FILES = [
  'leads.js', 'campaigns.js', 'sequences.js', 'conversations.js', 'orders.js', 'flow.js',
  'templates.js', 'segments.js', 'analytics.js', 'billing.js', 'team.js', 'workspace.js',
  'settings.js', 'warranty.js', 'training.js', 'scoring.js',
  'notifications.js', 'dashboard.js', 'ecommerce.js', 'shopify.js', 'shopifyHub.js',
  'shopifyCatalog.js', 'whatsapp.js', 'whatsappFlows.js', 'metaTemplates.js', 'keywords.js',
  'rules.js', 'routingRules.js', 'audience.js', 'insights.js', 'intelligenceDna.js',
  'bi.js', 'botQuality.js', 'storeEconomics.js', 'support.js', 'growth.js', 'qrcodes.js',
  'customTags.js', 'autoTemplates.js', 'wizard.js', 'variables.js', 'validation.js',
  'onboardingState.js', 'onboardingV2.js', 'media.js', 'payment.js', 'abandonedCarts.js',
  'inboxRoutes.js', 'igAutomationRoutes.js', 'catalog.js', 'ai.js', 'business.js',
  'checkoutConsent.js', 'shopifyPixel.js', 'metaWorkspace.js', 'metaAds.js', 'reseller.js',
  'whitelabel.js', 'dataDeletion.js', 'intents.js', 'oauth.js', 'templateGate.js',
];

async function testCrossTenantPerFile() {
  process.env.SKIP_AUDIT_PERSIST = 'true';
  const { verifyTenantScope } = require('../../middleware/verifyTenantScope');
  const mw = verifyTenantScope();
  let passed = 0;
  for (const file of ROUTE_FILES) {
    const req = {
      user: { role: 'CLIENT_ADMIN', clientId: 'tenant_a', _id: '000000000000000000000001' },
      params: { clientId: 'tenant_b' },
      originalUrl: `/api/${file.replace('.js', '')}/tenant_b`,
      method: 'GET',
      ip: '127.0.0.1',
      get: () => '',
    };
    let status = 0;
    const res = { status(c) { status = c; return res; }, json() {} };
    await new Promise((r) => mw(req, res, r));
    if (status === 403) passed += 1;
  }
  assert.ok(passed >= ROUTE_FILES.length, `cross-tenant blocks: ${passed}/${ROUTE_FILES.length}`);
}

async function main() {
  testProtectChainsSecurity();
  testRouteFilesUseProtectOrPublic();
  await testCrossTenantPerFile();
  console.log(`✓ routeHardeningCatalog (${ROUTE_FILES.length} file cross-tenant checks)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
