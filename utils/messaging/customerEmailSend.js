const crypto = require('crypto');
const { sendWorkspaceEmailDirect } = require('../core/emailService');

function emailIdempotencyKey(clientId, to, subject) {
  const hash = crypto
    .createHash('sha256')
    .update(`${subject || ''}`)
    .digest('hex')
    .slice(0, 12);
  return `email:${clientId}:${String(to).toLowerCase()}:${hash}`;
}

/**
 * Direct customer email transport (no nested sendEnvelope — outer callers own envelope gates).
 * @returns {boolean|null} true on success; false on failure; null → missing recipient
 */
async function tryCustomerEmailEnvelope(
  client,
  { to, subject, html, text, intent = 'marketing', contactId = null, source = 'emailService' }
) {
  if (!to) return null;

  const sendOut = await sendWorkspaceEmailDirect(client, {
    to,
    subject,
    html,
    text,
  });

  if (!sendOut?.success) {
    console.warn(`[customerEmailSend] Direct send failed (${source}): ${sendOut?.error || 'unknown'}`);
    return false;
  }
  return true;
}

module.exports = { tryCustomerEmailEnvelope, emailIdempotencyKey };
