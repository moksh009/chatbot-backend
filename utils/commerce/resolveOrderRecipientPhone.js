'use strict';

const AdLead = require('../../models/AdLead');
const Order = require('../../models/Order');
const { resolveShopifyOrderContact } = require('./resolveShopifyOrderContact');
const { indianPhoneLookupVariants } = require('../core/normalizeIndianPhone');

function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/**
 * Resolve customer phone for order-status WhatsApp sends.
 * Shopify payload → lead checkout_token / email → persisted Order.customerPhone.
 */
async function resolveOrderRecipientPhone(client, payload = {}) {
  const clientId = client?.clientId;
  if (!clientId) return '';

  const contact = resolveShopifyOrderContact(client, payload);
  let phone = contact.cleanPhone ? digitsOnly(contact.cleanPhone) : '';

  if (!phone && contact.checkoutToken) {
    const lead = await AdLead.findOne({
      clientId,
      $or: [
        { checkoutToken: contact.checkoutToken },
        { 'cartSnapshot.checkoutToken': contact.checkoutToken },
      ],
    })
      .select('phoneNumber')
      .lean();
    const pn = lead?.phoneNumber;
    if (pn && !String(pn).startsWith('unknown_')) {
      phone = digitsOnly(pn);
    }
  }

  if (!phone && contact.email) {
    const lead = await AdLead.findOne({ clientId, email: contact.email })
      .select('phoneNumber')
      .lean();
    const pn = lead?.phoneNumber;
    if (pn && !String(pn).startsWith('unknown_')) {
      phone = digitsOnly(pn);
    }
  }

  if (!phone) {
    const orderId = String(payload.id || payload.order_id || '');
    if (orderId) {
      const orderDoc = await Order.findOne({ clientId, shopifyOrderId: orderId })
        .select('customerPhone')
        .lean();
      if (orderDoc?.customerPhone) {
        phone = digitsOnly(orderDoc.customerPhone);
      }
    }
  }

  return phone;
}

function phoneLookupVariants(phone) {
  const d = digitsOnly(phone);
  if (!d) return [];
  return indianPhoneLookupVariants(d);
}

module.exports = {
  resolveOrderRecipientPhone,
  phoneLookupVariants,
  digitsOnly,
};
