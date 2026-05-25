const assert = require('assert');
const { assertTransition, ALLOWED } = require('../utils/messaging/transitions/campaignMessageTransition');
const { assertStepTransition } = require('../utils/messaging/transitions/sequenceStepTransition');

function testCampaignTransitions() {
  assert.ok(ALLOWED.queued.has('processing'));
  assert.throws(() => assertTransition('queued', 'delivered'));
}

function testSequenceTransitions() {
  assert.ok(assertStepTransition);
  assert.throws(() => assertStepTransition('sent', 'processing'));
}

let failed = 0;
for (const [name, fn] of [
  ['campaignTransitions', testCampaignTransitions],
  ['sequenceTransitions', testSequenceTransitions],
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
