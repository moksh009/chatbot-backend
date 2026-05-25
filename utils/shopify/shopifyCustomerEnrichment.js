'use strict';

const { normalizePhone } = require('../core/helpers');

/**
 * Attach TopEdge workspace signals (loyalty, warranty, lead) to Shopify customers.
 * @param {string} clientId
 * @param {object[]} shopifyCustomers
 */
async function enrichShopifyCustomers(clientId, shopifyCustomers = []) {
  if (!clientId || !Array.isArray(shopifyCustomers) || shopifyCustomers.length === 0) {
    return shopifyCustomers;
  }

  const AdLead = require('../../models/AdLead');
  const CustomerWallet = require('../../models/CustomerWallet');
  const Client = require('../../models/Client');

  const client = await Client.findOne({ clientId })
    .select('loyaltyConfig enableWarranty')
    .lean();
  const loyaltyEnabled = Boolean(client?.loyaltyConfig?.isEnabled);
  const warrantyEnabled = Boolean(client?.enableWarranty);

  const phoneSet = new Set();
  const emailSet = new Set();
  for (const c of shopifyCustomers) {
    const p = normalizePhone(c.phone);
    if (p) phoneSet.add(p);
    const em = String(c.email || '').trim().toLowerCase();
    if (em) emailSet.add(em);
  }
  const phones = [...phoneSet];
  const emails = [...emailSet];

  const [wallets, leadsByPhone, leadsByEmail] = await Promise.all([
    loyaltyEnabled && phones.length
      ? CustomerWallet.find({ clientId, phone: { $in: phones } })
          .select('phone balance tier lifetimePoints')
          .lean()
      : [],
    phones.length
      ? AdLead.find({ clientId, phoneNumber: { $in: phones } })
          .select('phoneNumber email name leadScore warrantyRecords tags')
          .lean()
      : [],
    emails.length
      ? AdLead.find({ clientId, email: { $in: emails } })
          .select('phoneNumber email name leadScore warrantyRecords tags')
          .lean()
      : [],
  ]);

  const walletByPhone = new Map((wallets || []).map((w) => [w.phone, w]));
  const leadByPhone = new Map();
  for (const lead of leadsByPhone || []) {
    const p = normalizePhone(lead.phoneNumber);
    if (p) leadByPhone.set(p, lead);
  }
  const leadByEmail = new Map();
  for (const lead of leadsByEmail || []) {
    const em = String(lead.email || '').trim().toLowerCase();
    if (em && !leadByEmail.has(em)) leadByEmail.set(em, lead);
  }

  return shopifyCustomers.map((c) => {
    const phone = normalizePhone(c.phone);
    const email = String(c.email || '').trim().toLowerCase();
    const lead = (phone && leadByPhone.get(phone)) || (email && leadByEmail.get(email)) || null;
    const wallet = phone ? walletByPhone.get(phone) : null;

    const warrantyRecords = lead?.warrantyRecords || [];
    const activeWarranty = warrantyRecords.filter((w) => w.status === 'active').length;

    return {
      ...c,
      workspacePhone: phone || normalizePhone(lead?.phoneNumber) || null,
      leadId: lead?._id ? String(lead._id) : null,
      leadName: lead?.name || null,
      leadScore: lead?.leadScore ?? null,
      loyaltyPoints: loyaltyEnabled && wallet ? wallet.balance : null,
      loyaltyTier: loyaltyEnabled && wallet ? wallet.tier : null,
      loyaltyLifetime: loyaltyEnabled && wallet ? wallet.lifetimePoints : null,
      loyaltyEnabled,
      warrantyActive: warrantyEnabled ? activeWarranty : null,
      warrantyTotal: warrantyEnabled ? warrantyRecords.length : null,
      warrantyEnabled,
    };
  });
}

module.exports = { enrichShopifyCustomers };
