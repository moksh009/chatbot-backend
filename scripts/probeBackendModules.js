#!/usr/bin/env node
/**
 * Load every route module the server mounts — catches MODULE_NOT_FOUND before deploy.
 * Writes NDJSON to session debug log (same path as agentDebugLog).
 */
const path = require('path');
const { agentDebug } = require('../utils/agentDebugLog');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const modules = [
  './routes/auth',
  './routes/conversations',
  './routes/analytics',
  './routes/campaigns',
  './routes/tracking',
  './routes/dynamicClientRouter',
  './routes/templates',
  './routes/whatsapp',
  './routes/knowledge',
  './routes/scoring',
  './routes/insights',
  './routes/segments',
  './routes/ecommerce',
  './routes/sequences',
  './routes/settings',
  './routes/flow',
  './routes/ai',
  './routes/publicWarranty',
  './routes/bi',
  './routes/orders',
  './routes/business',
  './routes/shopifyOAuth',
  './routes/shopify',
  './routes/shopifyHub',
  './routes/shopifyWebhook',
  './routes/admin',
  './routes/media',
  './routes/autoTemplates',
  './routes/whatsappFlows',
  './routes/emailWebhook',
  './routes/payment',
  './routes/billing',
  './routes/notifications',
  './routes/dashboard',
  './routes/storeEconomics',
  './routes/support',
  './routes/validation',
  './routes/oauth',
  './routes/wizard',
  './routes/variables',
  './routes/onboardingV2',
  './routes/onboarding',
  './routes/team',
  './routes/rules',
  './routes/leads',
  './routes/audience',
  './routes/routingRules',
  './routes/intents',
  './routes/intentWebhooks',
  './routes/razorpayWebhook',
  './routes/shopifyPixel',
  './routes/wooPixel',
  './routes/qrcodes',
  './routes/catalog',
  './routes/training',
  './routes/metaAds',
  './routes/whitelabel',
  './routes/dataDeletion',
  './routes/reseller',
  './routes/loyalty',
  './routes/warranty',
  './routes/templateGate',
  './routes/botQuality',
  './routes/intelligenceDna',
  './routes/keywords',
  './routes/instagramAutomation',
  './routes/igAutomationRoutes',
  './routes/inboxRoutes',
  './routes/masterWebhook',
  './routes/productTriggers',
  './routes/webhooks',
  './routes/instagramWebhook',
  './routes/engines/genericAppointment',
  './routes/engines/genericEcommerce'
];

let ok = 0;
let fail = 0;
for (const mod of modules) {
  try {
    const resolved = require.resolve(mod, { paths: [ROOT] });
    delete require.cache[resolved];
    require(resolved);
    ok += 1;
    agentDebug({
      hypothesisId: 'H1',
      runId: 'probe',
      location: 'scripts/probeBackendModules.js',
      message: 'module_ok',
      data: { mod }
    });
  } catch (e) {
    fail += 1;
    agentDebug({
      hypothesisId: 'H1',
      runId: 'probe',
      location: 'scripts/probeBackendModules.js',
      message: 'module_fail',
      data: { mod, code: e.code, err: String(e.message).slice(0, 500) }
    });
  }
}

agentDebug({
  hypothesisId: 'H1',
  runId: 'probe',
  location: 'scripts/probeBackendModules.js',
  message: 'probe_summary',
  data: { ok, fail, total: modules.length }
});

console.log(JSON.stringify({ ok, fail, total: modules.length }));
process.exit(fail ? 1 : 0);
