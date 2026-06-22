const assert = require('assert');
const { checkConsent } = require('../utils/messaging/checks/checkConsent');
const { checkServiceWindow } = require('../utils/messaging/checks/checkServiceWindow');
const { generateIdempotencyKey } = require('../utils/messaging/idempotency');
const { consumeTokenBucket } = require('../utils/messaging/rateLimits');

async function run() {
  const contactIn = { channelConsent: { whatsapp: { status: 'opted_in' } } };
  const contactOut = { channelConsent: { whatsapp: { status: 'opted_out' } } };

  assert.strictEqual(
    checkConsent({ contact: contactOut, channel: 'whatsapp', intent: 'marketing', strictMode: true }).pass,
    false
  );
  assert.strictEqual(
    checkConsent({ contact: contactIn, channel: 'whatsapp', intent: 'marketing', strictMode: true }).pass,
    true
  );
  assert.strictEqual(
    checkConsent({ contact: contactOut, channel: 'whatsapp', intent: 'transactional', strictMode: true }).pass,
    true
  );
  assert.strictEqual(
    checkConsent({ contact: contactOut, channel: 'whatsapp', intent: 'service', strictMode: true }).pass,
    true
  );
  assert.strictEqual(
    checkConsent({
      contact: contactOut,
      channel: 'whatsapp',
      intent: 'service',
      strictMode: true,
      complianceExempt: true,
    }).pass,
    true
  );

  assert.strictEqual(
    checkServiceWindow({
      channel: 'whatsapp',
      intent: 'service',
      payload: { text: 'hi' },
      contact: { lastInboundAt: new Date() },
    }).pass,
    true
  );
  assert.strictEqual(
    checkServiceWindow({
      channel: 'whatsapp',
      intent: 'service',
      payload: { text: 'hi' },
      contact: { lastInboundAt: new Date(Date.now() - 26 * 60 * 60 * 1000) },
    }).pass,
    false
  );

  const keyA = generateIdempotencyKey({
    clientId: 'c1',
    contactId: 'x1',
    channel: 'whatsapp',
    intent: 'marketing',
    payload: { templateName: 'cart_1' },
  });
  const keyB = generateIdempotencyKey({
    clientId: 'c1',
    contactId: 'x1',
    channel: 'whatsapp',
    intent: 'marketing',
    payload: { templateName: 'cart_1' },
  });
  assert.strictEqual(keyA, keyB);

  const mem = new Map();
  const redis = {
    async get(k) { return mem.get(k) || null; },
    async set(k, v) { mem.set(k, v); return 'OK'; },
  };
  const ok1 = await consumeTokenBucket(redis, { key: 'tenant:a', capacity: 1, refillPerSec: 0.0001 });
  const ok2 = await consumeTokenBucket(redis, { key: 'tenant:a', capacity: 1, refillPerSec: 0.0001 });
  assert.strictEqual(ok1.pass, true);
  assert.strictEqual(ok2.pass, false);

  console.log('sendEnvelope checks tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
