const crypto = require('crypto');
const { cronEnvelopeSend } = require('./cronEnvelopeSend');

function emailIdempotencyKey(clientId, to, subject) {
  const hash = crypto
    .createHash('sha256')
    .update(`${subject || ''}`)
    .digest('hex')
    .slice(0, 12);
  return `email:${clientId}:${String(to).toLowerCase()}:${hash}`;
}

/**
 * Customer-facing email via sendEnvelope.
 * @returns {boolean|null} true/false if envelope ran; null → missing contact (caller may use transport)
 */
async function tryCustomerEmailEnvelope(
  client,
  { to, subject, html, intent = 'marketing', contactId = null, source = 'emailService' }
) {
  const out = await cronEnvelopeSend({
    client,
    clientId: client.clientId,
    channel: 'email',
    intent,
    email: to,
    contactId,
    idempotencyKey: emailIdempotencyKey(client.clientId, to, subject),
    payload: { subject, html },
    context: { source },
  });

  if (out.useLegacy) return null;
  return out.action === 'sent' || out.action === 'duplicate';
}

module.exports = { tryCustomerEmailEnvelope, emailIdempotencyKey };
