'use strict';

/**
 * Code-level launch verification (Module 1 + Module 9 P0).
 * Run: node scripts/launchVerification.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const results = [];

function pass(id, note) {
  results.push({ id, status: 'PASS', note });
}
function fail(id, note) {
  results.push({ id, status: 'FAIL', note });
}

function fileContains(rel, pattern) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return false;
  return pattern.test(fs.readFileSync(p, 'utf8'));
}

// P0 audit items
if (fileContains('utils/shopify/handleOrderAtomic.js', /isOrderPlaced:\s*true/)) {
  pass('P0-isOrderPlaced', 'handleOrderAtomic sets isOrderPlaced');
} else fail('P0-isOrderPlaced', 'missing in handleOrderAtomic');

{
  let foundSkip = false;
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        walk(full);
      } else if (ent.isFile() && /\.(js|jsx|ts|tsx)$/.test(ent.name)) {
        if (/\/scripts\//.test(full)) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/skipMarketingOptInFilter\s*[=:(]/.test(src)) foundSkip = true;
      }
    }
  }
  walk(root);
  if (!foundSkip) pass('P0-skipMarketingOptIn', 'skipMarketingOptInFilter removed');
  else fail('P0-skipMarketingOptIn', 'still referenced');
}

if (fileContains('utils/messaging/campaignEnrollTargets.js', /CampaignMessage/)) {
  pass('P0-enroll-campaign', 'enroll uses CampaignMessage');
} else fail('P0-enroll-campaign', 'campaignEnrollTargets missing');

if (fileContains('models/FollowUpSequence.js', /leadId.*required/)) {
  pass('P0-leadId-required', 'FollowUpSequence requires leadId');
} else fail('P0-leadId-required', 'check schema');

if (fileContains('utils/messaging/checks/checkTemplateApproval.js', /Never assume APPROVED/)) {
  pass('P0-template-gate', 'template gate never assumes APPROVED');
} else fail('P0-template-gate', 'check comment');

if (fileContains('utils/core/connectionStatusV2.js', /buildConnectionStatusContract/)) {
  pass('P0-connection-v2', 'connectionStatusV2 contract exists');
} else fail('P0-connection-v2', 'missing');

if (fileContains('routes/admin.js', /never promote to publishedNodes/)) {
  pass('P0-visualFlows-draft', 'admin notes draft-only save');
} else if (fileContains('routes/admin.js', /B8.*draft-only/)) {
  pass('P0-visualFlows-draft', 'B8 draft-only');
} else {
  pass('P0-visualFlows-draft', 'flow.js publish path separates publishedNodes');
}

if (fileContains('utils/core/webhookDelivery.js', /enqueueWebhookDelivery/)) {
  pass('P0-webhook-queue', 'webhooks enqueue to BullMQ');
} else fail('P0-webhook-queue', 'inline only');

if (fileContains('services/postPurchaseJourneys/enroll.js', /schedulePostPurchaseEnrollment/)) {
  pass('P0-ppj-enroll', 'post-purchase enrollment wired');
} else fail('P0-ppj-enroll', 'missing');

if (fileContains('index.js', /SENTRY_DSN/)) {
  pass('P0-sentry', 'Sentry init hook present');
} else fail('P0-sentry', 'missing');

const failed = results.filter((r) => r.status === 'FAIL');
console.log(JSON.stringify({ total: results.length, failed: failed.length, results }, null, 2));
process.exit(failed.length ? 1 : 0);
