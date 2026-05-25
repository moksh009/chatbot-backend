/**
 * Phase 2 Slice 3 — Wave 4 email + B5 template gate + B10 plan limits (no DB).
 */
const assert = require('assert');
const { resolvePlanLimits, PLAN_LIMITS } = require('../config/planCatalog');
const { emailIdempotencyKey } = require('../utils/messaging/customerEmailSend');
const { checkTemplateApproval } = require('../utils/messaging/checks/checkTemplateApproval');

function testResolvePlanLimitsStarter() {
  const starter = resolvePlanLimits('starter');
  const diyLite = PLAN_LIMITS.diy_lite;
  assert.strictEqual(starter.contacts, diyLite.contacts);
  assert.strictEqual(starter.messages, diyLite.messages);
}

function testResolvePlanLimitsUnknown() {
  const limits = resolvePlanLimits('not_a_real_plan_slug_xyz');
  assert.ok(limits);
  assert.strictEqual(limits.contacts, PLAN_LIMITS.diy_lite.contacts);
}

function testEmailIdempotencyKey() {
  const k = emailIdempotencyKey('client1', 'User@Example.com', 'Hello');
  assert.ok(k.startsWith('email:client1:user@example.com:'));
  assert.strictEqual(k.length, 'email:client1:user@example.com:'.length + 12);
}

async function testTemplateApprovalRedisFailure() {
  const redis = {
    get: async () => {
      throw new Error('redis unavailable');
    },
  };
  const r = await checkTemplateApproval({
    redis,
    clientId: 'c1',
    payload: { templateName: 'loyalty_points_reminder' },
    intent: 'marketing',
  });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, 'check_failed');
}

function testSendSystemEmailExport() {
  const { sendSystemEmail, sendEmail } = require('../utils/core/emailService');
  assert.strictEqual(typeof sendEmail, 'function');
  assert.strictEqual(typeof sendSystemEmail, 'function');
}

let failed = 0;
const tests = [
  ['resolvePlanLimitsStarter', testResolvePlanLimitsStarter],
  ['resolvePlanLimitsUnknown', testResolvePlanLimitsUnknown],
  ['emailIdempotencyKey', testEmailIdempotencyKey],
  ['templateApprovalRedisFailure', testTemplateApprovalRedisFailure],
  ['sendSystemEmailExport', testSendSystemEmailExport],
];

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`✗ ${name}:`, e.message);
    }
  }
  process.exit(failed ? 1 : 0);
})();
