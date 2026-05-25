"use strict";

const VisitorIdentity = require("../../models/VisitorIdentity");
const AdLead = require("../../models/AdLead");
const { normalizePhoneWithCountry } = require("../core/helpers");

/**
 * Stitch anonymous visitor ↔ Shopify client_id ↔ checkout token ↔ AdLead.
 */
async function stitchVisitorIdentity(clientId, client, payload = {}) {
  const {
    visitorId,
    shopifyClientId,
    checkoutToken,
    phone: rawPhone,
    email,
    leadId,
  } = payload;

  const phone = rawPhone ? normalizePhoneWithCountry(rawPhone, client) : "";
  const token = checkoutToken ? String(checkoutToken).trim() : "";
  const vid = visitorId ? String(visitorId).trim() : "";
  const scid = shopifyClientId ? String(shopifyClientId).trim() : "";
  const em = email ? String(email).trim().toLowerCase() : "";

  if (!vid && !scid && !token && !phone && !em) {
    return { visitor: null, lead: null };
  }

  const or = [];
  if (vid) or.push({ visitorId: vid });
  if (scid) or.push({ shopifyClientId: scid });
  if (token) or.push({ checkoutTokens: token });

  let visitor = or.length
    ? await VisitorIdentity.findOne({ clientId, $or: or }).sort({ lastSeen: -1 })
    : null;

  if (!visitor && (vid || scid)) {
    visitor = new VisitorIdentity({
      clientId,
      visitorId: vid || `anon_${Date.now()}`,
      shopifyClientId: scid,
      firstSeen: new Date(),
      lastSeen: new Date(),
    });
  } else if (!visitor && token) {
    visitor = new VisitorIdentity({
      clientId,
      visitorId: vid || `tok_${token.slice(0, 12)}`,
      firstSeen: new Date(),
      lastSeen: new Date(),
    });
  }

  if (!visitor) return { visitor: null, lead: null };

  if (vid && !visitor.visitorId) visitor.visitorId = vid;
  if (scid) visitor.shopifyClientId = scid;
  if (token && !(visitor.checkoutTokens || []).includes(token)) {
    visitor.checkoutTokens = [...(visitor.checkoutTokens || []), token].slice(-20);
  }
  if (em) visitor.email = em;
  if (phone) visitor.phone = phone;
  if (leadId) visitor.leadId = leadId;
  visitor.lastSeen = new Date();
  await visitor.save();

  let lead = null;
  if (phone) {
    lead = await AdLead.findOne({ clientId, phoneNumber: phone });
  } else if (em) {
    lead = await AdLead.findOne({ clientId, email: em });
  } else if (visitor.leadId) {
    lead = await AdLead.findById(visitor.leadId);
  }

  if (lead && !visitor.leadId) {
    visitor.leadId = lead._id;
    await visitor.save();
  }

  if (phone && lead && token) {
    await AdLead.updateOne(
      { _id: lead._id },
      {
        $set: {
          checkoutToken: token,
          ...(em && { email: em }),
        },
      }
    );
  }

  return { visitor, lead };
}

/**
 * When webhook arrives with checkout token, link to prior pixel visitor.
 */
async function stitchCheckoutTokenToLead(clientId, checkoutToken, phone, email, client) {
  const token = String(checkoutToken || "").trim();
  if (!token) return null;

  const phoneNorm = phone ? normalizePhoneWithCountry(phone, client) : "";
  const visitor = await VisitorIdentity.findOne({
    clientId,
    checkoutTokens: token,
  }).sort({ lastSeen: -1 });

  if (visitor && phoneNorm) {
    visitor.phone = phoneNorm;
    if (email) visitor.email = String(email).toLowerCase();
    visitor.lastSeen = new Date();
    await visitor.save();
  }

  return stitchVisitorIdentity(clientId, client, {
    visitorId: visitor?.visitorId,
    shopifyClientId: visitor?.shopifyClientId,
    checkoutToken: token,
    phone: phoneNorm,
    email,
  });
}

module.exports = {
  stitchVisitorIdentity,
  stitchCheckoutTokenToLead,
};
