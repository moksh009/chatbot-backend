/**
 * Phase 2 Slice 2 — unit checks (no DB).
 */
const assert = require('assert');
const { idempotencyCod } = require('../utils/messaging/cronEnvelopeSend');

function testCodIdempotencyNdrStage() {
  const key = idempotencyCod({ orderId: 'ord-1', stage: 'ndr', contactId: 'abc', phone: '91x' });
  assert.strictEqual(key, 'cod:ord-1:ndr:abc');
}

function testFollowUpSchemaRequiresLeadId() {
  const path = require.resolve('../models/FollowUpSequence');
  delete require.cache[path];
  const FollowUpSequence = require('../models/FollowUpSequence');
  const doc = new FollowUpSequence({
    clientId: 'c1',
    phone: '919999999999',
    steps: [{ type: 'whatsapp', content: 'hi', sendAt: new Date(), status: 'pending' }],
  });
  const err = doc.validateSync();
  assert.ok(err?.errors?.leadId, `expected leadId validation error, got ${JSON.stringify(err?.errors)}`);
}

function testCampaignMessageEnumStillHasCancelled() {
  const CampaignMessage = require('../models/CampaignMessage');
  const values = CampaignMessage.schema.path('status').enumValues;
  assert.ok(values.includes('cancelled'));
}

let failed = 0;
for (const [name, fn] of [
  ['codIdempotencyNdr', testCodIdempotencyNdrStage],
  ['followUpLeadIdRequired', testFollowUpSchemaRequiresLeadId],
  ['campaignCancelledEnum', testCampaignMessageEnumStillHasCancelled],
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
