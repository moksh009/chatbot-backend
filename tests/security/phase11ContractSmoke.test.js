'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const FRONTEND_ROOT = path.join(BACKEND_ROOT, '..', 'chatbot-dashboard-frontend-main');

function readBackend(rel) {
  return fs.readFileSync(path.join(BACKEND_ROOT, rel), 'utf8');
}

function readFrontend(rel) {
  return fs.readFileSync(path.join(FRONTEND_ROOT, rel), 'utf8');
}

function testEnrollFromCampaignShipped() {
  const src = readBackend('routes/sequences.js');
  assert.ok(src.includes("router.post('/:clientId/enroll-from-campaign'"));
  assert.ok(!src.includes("code: 'NOT_SHIPPED_V1'"), 'enroll-from-campaign must not be 501 stub');
  assert.ok(src.includes('CampaignMessage.find'));
  assert.ok(src.includes('enqueueDueStepsForSequence'));
}

function testSegmentOrderSyncWired() {
  const src = readBackend('routes/segments.js');
  assert.ok(src.includes('syncOrderBackedCustomersToAdLeads'));
  const facet = readBackend('utils/commerce/leadsAnalyticsFacet.js');
  assert.ok(facet.includes('async function syncOrderBackedCustomersToAdLeads'));
  assert.ok(facet.includes('syncOrderBackedCustomersToAdLeads,'));
}

function testQrConversionWired() {
  const qr = readBackend('utils/commerce/qrInboundHandler.js');
  assert.ok(qr.includes('maybeAttributeQrConversion'));
  const order = readBackend('utils/shopify/handleOrderAtomic.js');
  assert.ok(order.includes('maybeAttributeQrConversion'));
  const scan = readBackend('models/QRScan.js');
  assert.ok(scan.includes('convertedAt'));
}

function testFrontendEnrollUi() {
  const panel = readFrontend('src/components/campaigns/CampaignDetailPanel.jsx');
  assert.ok(panel.includes('onEnrollInSequence'));
  assert.ok(panel.includes('whatsappDisconnected'));
  assert.ok(panel.includes('Enroll in sequence'));
  assert.ok(fs.existsSync(path.join(FRONTEND_ROOT, 'src/components/campaigns/EnrollCampaignSequenceModal.jsx')));
  const modal = readFrontend('src/components/campaigns/EnrollCampaignSequenceModal.jsx');
  assert.ok(modal.includes('enroll-from-campaign'));
  assert.ok(modal.includes('whatsappDisconnected'));
}

function testConversationResolveUnified() {
  const src = readBackend('routes/conversations.js');
  assert.ok(src.includes('applyConversationResolved'));
  assert.ok(src.includes('findConversationForResolve'));
  assert.ok(src.includes('tenantClientId(req)'));
  assert.ok(src.includes("pendingSupport: false"));
}

function testCampaignLaunchHardening() {
  const src = readBackend('routes/campaigns.js');
  assert.ok(src.includes("router.post('/start', protect, tenantRateLimit(), requirePaidOrTrial()"));
  const csvBlock = src.slice(
    src.indexOf("router.post('/', protect, upload.single('file')"),
    src.indexOf("router.post('/from-segment'")
  );
  const incrementIdx = csvBlock.indexOf('await incrementUsage(client._id, \'campaigns\', 1)');
  const validCountIdx = csvBlock.indexOf('const validCount = audience.length');
  assert.ok(incrementIdx > validCountIdx, 'CSV incrementUsage must run after audience validation');
  const mgr = readFrontend('src/pages/CampaignManager.jsx');
  assert.ok(mgr.includes('launch.enqueued === 0'));
}

function testMonorepoVerifyScript() {
  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(BACKEND_ROOT, '..', 'package.json'), 'utf8')
  );
  assert.ok(rootPkg.scripts['verify:production-readiness']);
  const script = fs.readFileSync(
    path.join(BACKEND_ROOT, '..', 'scripts', 'verify-production-readiness.sh'),
    'utf8'
  );
  assert.ok(script.includes('test:phase-11'));
  assert.ok(script.includes('qa:production-readiness'));
}

function main() {
  testEnrollFromCampaignShipped();
  testSegmentOrderSyncWired();
  testQrConversionWired();
  testFrontendEnrollUi();
  testConversationResolveUnified();
  testCampaignLaunchHardening();
  testMonorepoVerifyScript();
  console.log('✓ phase11ContractSmoke tests passed');
}

main();
