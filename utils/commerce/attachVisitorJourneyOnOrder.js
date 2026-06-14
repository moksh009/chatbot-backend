'use strict';

const VisitorIdentity = require('../../models/VisitorIdentity');
const AdLead = require('../../models/AdLead');
const { normalizeEmail } = require('./marketingConsent');

/**
 * Attach VisitorIdentity journey fields to AdLead on order match (NEW-4).
 */
async function attachVisitorJourneyOnOrder(client, lead, orderData = {}) {
  if (!client?.clientId || !lead?._id) return null;

  const email = normalizeEmail(
    orderData.email || orderData.contact_email || orderData.customer?.email || lead.email
  );
  const checkoutToken = String(orderData.checkout_token || orderData.token || lead.checkoutToken || '').trim();
  const phone = lead.phoneNumber || '';

  const or = [];
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  if (checkoutToken) or.push({ checkoutTokens: checkoutToken });
  if (!or.length) return null;

  const visitor = await VisitorIdentity.findOne({ clientId: client.clientId, $or: or })
    .sort({ lastSeen: -1 })
    .lean();
  if (!visitor) return null;

  let visitCount = 1;
  if (visitor.email) {
    visitCount = await VisitorIdentity.countDocuments({
      clientId: client.clientId,
      email: visitor.email,
    });
  } else if (visitor.phone) {
    visitCount = await VisitorIdentity.countDocuments({
      clientId: client.clientId,
      phone: visitor.phone,
    });
  }

  const patch = {
    visitorFirstVisitAt: visitor.firstSeen || visitor.createdAt,
    visitorVisitCount: Math.max(1, visitCount),
  };

  await AdLead.updateOne({ _id: lead._id, clientId: client.clientId }, { $set: patch });
  return patch;
}

module.exports = { attachVisitorJourneyOnOrder };
