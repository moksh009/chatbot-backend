const AdLead = require('../../models/AdLead');
const { normalizePhone } = require('../core/helpers');

/**
 * Guarantee a real AdLead exists before FollowUpSequence enrollment (Phase 2 D2).
 */
async function ensureLeadForSequence({
  clientId,
  phone,
  email = null,
  name = null,
  source = 'sequence_enrollment',
}) {
  const normalized = phone ? normalizePhone(phone) : null;
  if (!normalized && !email) {
    throw new Error('ensureLeadForSequence requires phone or email');
  }

  const filter = normalized
    ? { clientId, phoneNumber: normalized }
    : { clientId, email: String(email).trim().toLowerCase() };

  const insert = {
    clientId,
    phoneNumber: normalized || `unknown_email_${String(email).trim().toLowerCase().slice(0, 32)}`,
    source,
    createdAt: new Date(),
  };
  if (email) insert.email = String(email).trim().toLowerCase();
  if (name) insert.name = name;

  const lead = await AdLead.findOneAndUpdate(
    filter,
    { $setOnInsert: insert },
    { upsert: true, new: true }
  );

  return lead;
}

module.exports = { ensureLeadForSequence };
