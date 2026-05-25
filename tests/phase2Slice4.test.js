/**
 * Phase 2 Slice 4 — IG envelope + B6/B7/B8 (no DB).
 */
const assert = require('assert');
const { igPhoneFromIgsid } = require('../utils/messaging/ensureIgContact');
const {
  getLeadOrdersCount,
  getCartSnapshotTotal,
  normalizeCartSnapshotWrite,
} = require('../utils/core/leadFieldAccess');
const { buildComponentsForMetaSubmit } = require('../utils/meta/templateSubmitComponents');

function testIgPhoneKey() {
  assert.strictEqual(igPhoneFromIgsid('12345'), 'ig:12345');
}

function testLeadOrdersCountCanonical() {
  assert.strictEqual(getLeadOrdersCount({ ordersCount: 3 }), 3);
  assert.strictEqual(getLeadOrdersCount({ orderCount: 2 }, 'test'), 2);
  assert.strictEqual(getLeadOrdersCount({}), 0);
}

function testCartSnapshotTotal() {
  assert.strictEqual(getCartSnapshotTotal({ totalPrice: 99 }), 99);
  assert.strictEqual(getCartSnapshotTotal({ total_price: 50 }), 50);
  assert.strictEqual(getCartSnapshotTotal({}, { cartValue: 12 }), 12);
}

function testNormalizeCartSnapshotWrite() {
  const out = normalizeCartSnapshotWrite({ total_price: 100, items: [] });
  assert.strictEqual(out.totalPrice, 100);
  assert.strictEqual(out.total_price, 100);
}

function testBuildComponentsFromMetaTemplate() {
  const comps = buildComponentsForMetaSubmit({
    body: 'Hello {{1}}',
    headerType: 'TEXT',
    headerValue: 'Hi',
    buttons: [{ type: 'QUICK_REPLY', text: 'OK' }],
  });
  assert.ok(comps.some((c) => c.type === 'BODY'));
  assert.ok(comps.some((c) => c.type === 'HEADER'));
}

function testSendEnvelopeHasInstagramTransport() {
  const transports = require('../utils/messaging/transports');
  assert.strictEqual(typeof transports.sendInstagram, 'function');
}

function testIgEnvelopeDispatchExport() {
  const { dispatchIgEnvelope } = require('../utils/messaging/igEnvelopeDispatch');
  assert.strictEqual(typeof dispatchIgEnvelope, 'function');
}

let failed = 0;
for (const [name, fn] of [
  ['igPhoneKey', testIgPhoneKey],
  ['leadOrdersCountCanonical', testLeadOrdersCountCanonical],
  ['cartSnapshotTotal', testCartSnapshotTotal],
  ['normalizeCartSnapshotWrite', testNormalizeCartSnapshotWrite],
  ['buildComponentsFromMetaTemplate', testBuildComponentsFromMetaTemplate],
  ['sendEnvelopeHasInstagramTransport', testSendEnvelopeHasInstagramTransport],
  ['igEnvelopeDispatchExport', testIgEnvelopeDispatchExport],
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
