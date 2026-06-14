'use strict';

const assert = require('assert');
const {
  isHardBounceError,
  normalizeRecipientEmail,
  handleResendBounceWebhook,
} = require('../utils/core/emailBounceHandler');

assert.strictEqual(isHardBounceError('550 User not found'), true);
assert.strictEqual(isHardBounceError('Temporary failure try again'), false);
assert.strictEqual(isHardBounceError('', 550), true);
assert.strictEqual(isHardBounceError('Mailbox unavailable', null), true);

assert.strictEqual(normalizeRecipientEmail('  User@Example.COM '), 'user@example.com');
assert.strictEqual(normalizeRecipientEmail(''), '');

(async () => {
  assert.strictEqual(await handleResendBounceWebhook({ type: 'email.delivered' }), false);
  assert.strictEqual(
    await handleResendBounceWebhook({
      type: 'email.bounced',
      data: { to: 'bad@example.com', bounce: { message: '550 invalid' } },
    }),
    false
  );
})().then(() => {
  console.log('✓ emailBounceHandler');
});
