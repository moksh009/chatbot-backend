/**
 * Phase 3 smoke (no Redis/Mongo) — variant assignment + outcome classification.
 */
const assert = require('assert');
const { assignAbVariant } = require('../utils/messaging/dispatch/campaignProgress');
const { classifyEnvelopeOutcome } = require('../utils/messaging/dispatch/dispatchOutcomeHandler');

function testVariantDeterministic() {
  const variants = [
    { id: 'A', weight: 50 },
    { id: 'B', weight: 50 },
  ];
  const a = assignAbVariant({ campaignId: 'c1', leadKey: 'lead1', variants, holdbackPercent: 0 });
  const b = assignAbVariant({ campaignId: 'c1', leadKey: 'lead1', variants, holdbackPercent: 0 });
  assert.strictEqual(a.variantId, b.variantId);
}

function testConsentBlockCancelled() {
  const o = classifyEnvelopeOutcome({ status: 'blocked', blockedBy: 'consent', reason: 'opted_out' }, 1);
  assert.strictEqual(o.action, 'cancelled');
}

function testRateLimitRetry() {
  const o = classifyEnvelopeOutcome({ status: 'blocked', blockedBy: 'rate_limit', retryAfter: 30 }, 1);
  assert.strictEqual(o.action, 'retry');
}

let failed = 0;
for (const [name, fn] of [
  ['variantDeterministic', testVariantDeterministic],
  ['consentBlockCancelled', testConsentBlockCancelled],
  ['rateLimitRetry', testRateLimitRetry],
]) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`✗ ${name}:`, e.message);
  }
}
process.exit(failed ? 1 : 0);
