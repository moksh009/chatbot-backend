/**
 * Phase 2 Slice 1 — unit checks (no DB).
 */
const assert = require('assert');
const CampaignMessage = require('../models/CampaignMessage');
const {
  idempotencyCod,
  idempotencyCsat,
  idempotencyScheduled,
} = require('../utils/messaging/cronEnvelopeSend');

function testCampaignMessageEnum() {
  const paths = CampaignMessage.schema.path('status');
  const values = paths.enumValues || paths.options?.enum || [];
  assert.ok(values.includes('cancelled'), 'CampaignMessage.status must include cancelled');
  assert.ok(!values.includes('pending'), 'cancelled should not replace queued');
}

function testIdempotencyKeys() {
  assert.strictEqual(idempotencyCod({ orderId: 'o1', stage: 'confirm', contactId: 'abc' }), 'cod:o1:confirm:abc');
  assert.strictEqual(idempotencyCsat({ conversationId: 'c1', contactId: 'lead1' }), 'csat:c1:lead1');
  assert.strictEqual(idempotencyScheduled({ scheduledMessageId: 'sm1' }), 'sched:sm1');
}

function testScheduledIntentDefault() {
  const ScheduledMessage = require('../models/ScheduledMessage');
  const intentPath = ScheduledMessage.schema.path('intent');
  assert.ok(intentPath, 'ScheduledMessage.intent field exists');
  assert.strictEqual(intentPath.defaultValue, 'service');
}

let failed = 0;
for (const [name, fn] of [
  ['campaignMessageEnum', testCampaignMessageEnum],
  ['idempotencyKeys', testIdempotencyKeys],
  ['scheduledIntentDefault', testScheduledIntentDefault],
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
