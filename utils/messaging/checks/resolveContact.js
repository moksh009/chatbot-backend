const mongoose = require('mongoose');
const AdLead = require('../../../models/AdLead');

const CONTACT_PROJECTION = {
  _id: 1,
  clientId: 1,
  phoneNumber: 1,
  email: 1,
  channelConsent: 1,
  optStatus: 1,
  emailBounced: 1,
  tags: 1,
  suppressionFlag: 1,
  lastInboundAt: 1,
};

async function resolveContact({ clientId, contactId, channel, contact = {} }) {
  let query = null;
  if (contactId && mongoose.Types.ObjectId.isValid(String(contactId))) {
    query = { clientId, _id: contactId };
  } else if (channel === 'email' && contact.email) {
    query = { clientId, email: String(contact.email).trim().toLowerCase() };
  } else if (contact.igsid) {
    query = { clientId, phoneNumber: `ig:${String(contact.igsid).trim()}` };
  } else if (contact.phone) {
    query = { clientId, phoneNumber: String(contact.phone).replace(/\D/g, '') };
  }
  if (!query) return { pass: false, blockedBy: 'invalid_contact', reason: 'contact_lookup_key_missing' };
  const lead = await AdLead.findOne(query).select(CONTACT_PROJECTION).lean();
  if (!lead) return { pass: false, blockedBy: 'invalid_contact', reason: 'contact_not_found' };
  return { pass: true, contact: lead };
}

module.exports = { resolveContact };
