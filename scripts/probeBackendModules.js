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
let skippedOptional = 0;
const failedModules = [];
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
    const errMsg = String(e && e.message ? e.message : e);
    const isOptionalEnvError =
      errMsg.includes('Missing required Google OAuth2 configuration') ||
      errMsg.includes('GCAL_CLIENT_ID') ||
      errMsg.includes('GCAL_CLIENT_SECRET') ||
      errMsg.includes('GCAL_REFRESH_TOKEN');
    if (isOptionalEnvError) {
      skippedOptional += 1;
      agentDebug({
        hypothesisId: 'H1',
        runId: 'probe',
        location: 'scripts/probeBackendModules.js',
        message: 'module_skip_optional_env',
        data: { mod, err: errMsg.slice(0, 500) }
      });
      continue;
    }
    fail += 1;
    failedModules.push({ mod, code: e.code, err: errMsg.slice(0, 500) });
    agentDebug({
      hypothesisId: 'H1',
      runId: 'probe',
      location: 'scripts/probeBackendModules.js',
      message: 'module_fail',
      data: { mod, code: e.code, err: errMsg.slice(0, 500) }
    });
  }
}

agentDebug({
  hypothesisId: 'H1',
  runId: 'probe',
  location: 'scripts/probeBackendModules.js',
  message: 'probe_summary',
  data: { ok, fail, skippedOptional, total: modules.length, failedModules }
});

if (failedModules.length) {
  console.error('Failed modules:');
  failedModules.forEach((f) => console.error(`- ${f.mod}: ${f.err}`));
}
console.log(JSON.stringify({ ok, fail, skippedOptional, total: modules.length }));
process.exit(fail ? 1 : 0);
