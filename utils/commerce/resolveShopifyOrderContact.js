'use strict';

const { normalizePhoneWithCountry } = require('../core/helpers');
const { normalizeEmail } = require('./marketingConsent');

function extractShopifyOrderPhoneRaw(data = {}) {
  return (
    data.phone ||
    data.customer?.phone ||
    data.billing_address?.phone ||
    data.shipping_address?.phone ||
    data.customerPhone ||
    ''
  );
}

function extractShopifyOrderEmail(data = {}) {
  return normalizeEmail(
    data.email ||
      data.contact_email ||
      data.customer?.email ||
      data.billing_address?.email ||
      data.shipping_address?.email ||
      data.customerEmail
  );
}

function extractCheckoutToken(data = {}) {
  return String(data.checkout_token || data.token || data.checkoutToken || '').trim();
}

/**
 * Resolve phone / email / checkout token for order webhooks, pixel, and reconcile.
 */
function resolveShopifyOrderContact(client, data = {}) {
  const phoneRaw = extractShopifyOrderPhoneRaw(data);
  const cleanPhone = phoneRaw ? normalizePhoneWithCountry(phoneRaw, client) : '';
  const email = extractShopifyOrderEmail(data);
  const checkoutToken = extractCheckoutToken(data);
  return {
    cleanPhone,
    email,
    checkoutToken,
    canProcess: Boolean(cleanPhone || email || checkoutToken),
    matchVia: cleanPhone ? 'phone' : checkoutToken ? 'checkout_token' : email ? 'email' : null,
  };
}

module.exports = {
  extractShopifyOrderPhoneRaw,
  extractShopifyOrderEmail,
  extractCheckoutToken,
  resolveShopifyOrderContact,
};
