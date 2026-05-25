const ALLOWED_CHANNELS = new Set(['whatsapp', 'instagram', 'email']);
const ALLOWED_INTENTS = new Set(['marketing', 'utility', 'authentication', 'service', 'transactional']);

function validateInput(envelope) {
  if (!envelope?.clientId) return { pass: false, blockedBy: 'invalid_contact', reason: 'clientId_required' };
  if (!ALLOWED_CHANNELS.has(envelope.channel)) return { pass: false, blockedBy: 'invalid_contact', reason: 'invalid_channel' };
  if (!ALLOWED_INTENTS.has(envelope.intent)) return { pass: false, blockedBy: 'invalid_contact', reason: 'invalid_intent' };
  if (!envelope.payload || typeof envelope.payload !== 'object') {
    return { pass: false, blockedBy: 'invalid_contact', reason: 'payload_required' };
  }
  if (!envelope.contactId && !(envelope?.contact?.phone || envelope?.contact?.email)) {
    return { pass: false, blockedBy: 'invalid_contact', reason: 'contact_required' };
  }
  return { pass: true };
}

module.exports = { validateInput };
