'use strict';

const Client = require('../../models/Client');
const AdLead = require('../../models/AdLead');
const { normalizePhoneWithCountry } = require('../core/helpers');
const { stitchVisitorIdentity } = require('./visitorIdentityService');
const log = require('../core/logger')('CheckoutMarketingConsent');

/**
 * Record marketing opt-in from Shopify Checkout UI extension or storefront checkbox.
 */
async function recordCheckoutMarketingOptIn({
  clientId,
  phone: phoneRaw,
  email,
  checkoutToken,
  shopifyClientId,
  visitorId,
  marketingOptIn = true,
  source = 'checkout_extension',
}) {
  if (!clientId) return { success: false, reason: 'missing_client' };
  if (!marketingOptIn) return { success: false, reason: 'not_opted_in' };

  const client = await Client.findOne({ clientId }).select('clientId shopDomain').lean();
  if (!client) return { success: false, reason: 'client_not_found' };

  const phone = phoneRaw ? normalizePhoneWithCountry(phoneRaw, client) : null;
  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
  if (!phone && !normalizedEmail) {
    return { success: false, reason: 'missing_contact' };
  }

  const now = new Date();
  const query = phone
    ? { clientId, phoneNumber: phone }
    : { clientId, email: normalizedEmail };

  const lead = await AdLead.findOneAndUpdate(
    query,
    {
      $set: {
        optStatus: 'opted_in',
        optInDate: now,
        optInSource: source,
        whatsappMarketingEligible: !!phone,
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
        ...(checkoutToken ? { checkoutToken } : {}),
      },
      $addToSet: { tags: 'Checkout Opt-in' },
      $push: {
        optInHistory: {
          $each: [
            {
              event: 'opted_in',
              action: 'opted_in',
              timestamp: now,
              source,
              note: 'Checkout marketing checkbox',
            },
          ],
          $position: 0,
          $slice: 40,
        },
      },
      $setOnInsert: {
        clientId,
        phoneNumber: phone || undefined,
        name: 'Checkout Customer',
        source: 'shopify_checkout',
        createdAt: now,
      },
    },
    { upsert: !!phone, new: true }
  );

  if (!lead && !phone) {
    return { success: false, reason: 'email_only_no_lead' };
  }

  if (visitorId || shopifyClientId || checkoutToken) {
    try {
      await stitchVisitorIdentity(clientId, client, {
        visitorId,
        shopifyClientId,
        checkoutToken,
        phone,
        email: normalizedEmail,
        leadId: lead?._id,
      });
    } catch (e) {
      log.warn(`Identity stitch on checkout opt-in failed: ${e.message}`);
    }
  }

  log.info(`[CheckoutOptIn] ${clientId} phone=${phone || '—'} email=${normalizedEmail || '—'}`);
  return { success: true, leadId: lead?._id, phone, email: normalizedEmail };
}

module.exports = { recordCheckoutMarketingOptIn };
