/**
 * Phase 2 Slice 5 — cancelAllAutomationsFor wiring (no DB).
 */
const assert = require('assert');
const {
  phoneVariants,
  CART_RECOVERY_TYPES,
  normalizeCancelReason,
  mapOptOutSourceToCancelReason,
  VALID_REASONS,
} = require('../utils/messaging/cancelAllAutomationsFor');

function testValidReasons() {
  for (const r of [
    'order_placed',
    'stop_keyword',
    'erasure_request',
    'agent_block',
    'unsubscribe_link',
  ]) {
    assert.ok(VALID_REASONS.has(r), `missing ${r}`);
  }
}

function testMapOptOutSource() {
  assert.strictEqual(mapOptOutSourceToCancelReason('keyword_stop'), 'stop_keyword');
  assert.strictEqual(mapOptOutSourceToCancelReason('whatsapp_block'), 'agent_block');
  assert.strictEqual(mapOptOutSourceToCancelReason('admin_manual'), 'agent_block');
  assert.strictEqual(mapOptOutSourceToCancelReason('unsubscribe_link'), 'unsubscribe_link');
  assert.strictEqual(mapOptOutSourceToCancelReason('erasure_request'), 'erasure_request');
}

function testNormalizeCancelReason() {
  assert.strictEqual(normalizeCancelReason('bogus'), 'stop_keyword');
  assert.strictEqual(normalizeCancelReason('order_placed'), 'order_placed');
}

function testCartRecoveryScope() {
  assert.ok(CART_RECOVERY_TYPES.includes('abandoned_cart'));
  assert.ok(!CART_RECOVERY_TYPES.includes('loyalty_reminder'));
}

function testOptOutKillSwitchDelegates() {
  const mod = require('../utils/commerce/optOutKillSwitch');
  assert.strictEqual(typeof mod.cancelPendingJobsForContact, 'function');
  assert.strictEqual(typeof mod.executeGlobalOptOut, 'function');
}

function testPublicUnsubscribeUsesHelper() {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../routes/publicUnsubscribe.js'),
    'utf8'
  );
  assert.ok(src.includes('cancelAllAutomationsFor'));
  assert.ok(!src.includes('FollowUpSequence.updateMany'));
}

function testErasureUsesHelper() {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/leads.js'), 'utf8');
  const idx = src.indexOf("'/erasure-request'");
  assert.ok(idx > 0);
  const chunk = src.slice(idx, idx + 1200);
  assert.ok(chunk.includes('cancelAllAutomationsFor'));
  assert.ok(chunk.includes("reason: 'erasure_request'"));
}

let failed = 0;
for (const [name, fn] of [
  ['validReasons', testValidReasons],
  ['mapOptOutSource', testMapOptOutSource],
  ['normalizeCancelReason', testNormalizeCancelReason],
  ['cartRecoveryScope', testCartRecoveryScope],
  ['optOutKillSwitchDelegates', testOptOutKillSwitchDelegates],
  ['publicUnsubscribeUsesHelper', testPublicUnsubscribeUsesHelper],
  ['erasureUsesHelper', testErasureUsesHelper],
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
