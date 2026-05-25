const AdLead = require('../../models/AdLead');

function igPhoneFromIgsid(igsid) {
  return `ig:${String(igsid).trim()}`;
}

/**
 * Upsert AdLead row for Instagram scoped user id (envelope contact resolution).
 */
async function ensureIgContact({ clientId, igsid, commentId }) {
  const phoneNumber = igsid
    ? igPhoneFromIgsid(igsid)
    : commentId
      ? `ig:comment:${String(commentId)}`
      : null;
  if (!phoneNumber) return null;
  return AdLead.findOneAndUpdate(
    { clientId, phoneNumber },
    {
      $set: {
        lastInteraction: new Date(),
        ...(igsid ? { 'meta.igsid': String(igsid) } : {}),
        ...(commentId ? { 'meta.igCommentId': String(commentId) } : {}),
      },
      $setOnInsert: {
        clientId,
        phoneNumber,
        source: 'instagram',
        optStatus: 'unknown',
      },
    },
    { upsert: true, new: true }
  ).lean();
}

module.exports = { ensureIgContact, igPhoneFromIgsid };
