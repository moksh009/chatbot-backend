'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function testNoShopifyDevBypass() {
  const src = read('routes/shopifyWebhook.js');
  assert.ok(src.includes('webhook_signature_failed'));
  assert.ok(!src.match(/Invalid HMAC[\s\S]{0,200}next\(\)/));
}

function testNoDualEmit() {
  const src = read('utils/core/socketEmit.js');
  assert.ok(!src.includes('LEGACY_EVENT_ALIASES'));
  assert.ok(!src.includes('legacy_socket_emit'));
}

function testMiddlewareExists() {
  assert.ok(fs.existsSync(path.join(ROOT, 'middleware/verifyTenantScope.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'middleware/requirePaidOrTrial.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'middleware/tenantRateLimit.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'services/audit/auditWriter.js')));
}

function testGdprScripts() {
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/gdpr/exportLead.js')));
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/gdpr/eraseLead.js')));
}

function testRequireRoleNoHardcodedBypass() {
  const src = read('middleware/requireRole.js');
  assert.ok(!src.includes('delitech2708'));
}

function testRazorpayWebhook401() {
  const src = read('routes/razorpayWebhook.js');
  assert.ok(src.includes('status(401)'));
}

function testLegacyRoutes410() {
  const flow = read('routes/flow.js');
  const admin = read('routes/admin.js');
  assert.ok(flow.includes("status(410)") && flow.includes('/ai-build'));
  assert.ok(admin.includes("status(410)") && admin.includes('/flow/publish'));
}

function testReplayWired() {
  const shopify = read('routes/shopifyWebhook.js');
  const master = read('routes/masterWebhook.js');
  const razorpay = read('routes/razorpayWebhook.js');
  const dynamic = read('routes/dynamicClientRouter.js');
  const ig = read('controllers/igAutomation/webhookController.js');
  assert.ok(shopify.includes('shopifyReplay'));
  assert.ok(master.includes('metaPayloadReplayGuard'));
  assert.ok(razorpay.includes('razorpayReplay'));
  assert.ok(dynamic.includes('metaPayloadReplayGuard'));
  assert.ok(ig.includes('igWebhookReplayGuard'));
}

async function main() {
  testNoShopifyDevBypass();
  testNoDualEmit();
  testMiddlewareExists();
  testGdprScripts();
  testRequireRoleNoHardcodedBypass();
  testRazorpayWebhook401();
  testLegacyRoutes410();
  testReplayWired();
  console.log('✓ securitySmoke tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
