/**
 * Phase 2 Wave 2A unit checks (no DB).
 */
const assert = require('assert');
const { phoneVariants, CART_RECOVERY_TYPES } = require('../utils/messaging/cancelAllAutomationsFor');
const { interpretEnvelopeResult, intentFromTemplateCategory } = require('../utils/messaging/envelopeHelpers');
const { hasRealPhone } = require('../utils/messaging/cronEnvelopeSend');

function testPhoneVariants() {
  const v = phoneVariants('+919876543210');
  assert.ok(v.includes('919876543210'));
  assert.ok(v.includes('9876543210') || v.some((x) => x.endsWith('9876543210')));
}

function testIntentMapping() {
  assert.strictEqual(intentFromTemplateCategory('UTILITY'), 'utility');
  assert.strictEqual(intentFromTemplateCategory('MARKETING'), 'marketing');
}

function testEnvelopeOutcomes() {
  assert.strictEqual(interpretEnvelopeResult({ status: 'duplicate' }).action, 'duplicate');
  assert.strictEqual(
    interpretEnvelopeResult({ status: 'blocked', blockedBy: 'rate_limit', retryAfter: 30 }).action,
    'rate_limit'
  );
  assert.strictEqual(
    interpretEnvelopeResult({ status: 'blocked', blockedBy: 'consent', reason: 'opted_out' }).action,
    'skipped'
  );
}

function testHasRealPhone() {
  assert.strictEqual(hasRealPhone('919876543210'), true);
  assert.strictEqual(hasRealPhone('unknown_checkout_abc'), false);
  assert.strictEqual(hasRealPhone(''), false);
}

function testCartRecoveryTypes() {
  assert.ok(CART_RECOVERY_TYPES.includes('abandoned_cart'));
  assert.ok(!CART_RECOVERY_TYPES.includes('cart_recovery'));
}

let failed = 0;
for (const [name, fn] of [
  ['phoneVariants', testPhoneVariants],
  ['intentMapping', testIntentMapping],
  ['envelopeOutcomes', testEnvelopeOutcomes],
  ['hasRealPhone', testHasRealPhone],
  ['cartRecoveryTypes', testCartRecoveryTypes],
]) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}:`, e.message);
  }
}
process.exit(failed ? 1 : 0);
