'use strict';

const { normalizePhone } = require('../core/helpers');

function normalizeTagsArray(tags) {
  if (tags == null || tags === '') return [];
  if (Array.isArray(tags)) {
    return tags.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof tags === 'string') {
    return tags
      .split(/[,;|]/)
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Attach TopEdge workspace signals (warranty, lead) to Shopify customers.
 * @param {string} clientId
 * @param {object[]} shopifyCustomers
 */
async function enrichShopifyCustomers(clientId, shopifyCustomers = []) {
  if (!clientId || !Array.isArray(shopifyCustomers) || shopifyCustomers.length === 0) {
    return shopifyCustomers;
  }

  const AdLead = require('../../models/AdLead');
  const Client = require('../../models/Client');

  const client = await Client.findOne({ clientId })
    .select('enableWarranty')
    .lean();
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

  const ScoreTierConfig = require('../../models/ScoreTierConfig');
  const { resolveScoreStageName } = require('../commerce/customerOrderMetrics');

  const tierDoc = await ScoreTierConfig.findOne({ clientId }).select('tiers').lean();
  const scoreTiers = tierDoc?.tiers?.length
    ? tierDoc.tiers
    : ScoreTierConfig.getDefaultConfig(clientId).tiers;

  const [leadsByPhone, leadsByEmail] = await Promise.all([
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

    const warrantyRecords = lead?.warrantyRecords || [];
    const activeWarranty = warrantyRecords.filter((w) => w.status === 'active').length;

    return {
      ...c,
      workspacePhone: phone || normalizePhone(lead?.phoneNumber) || null,
      leadId: lead?._id ? String(lead._id) : null,
      leadName: lead?.name || null,
      leadScore: lead?.leadScore ?? null,
      scoreStageName: resolveScoreStageName(lead?.leadScore ?? 0, scoreTiers),
      tags: normalizeTagsArray(lead?.tags),
      warrantyActive: warrantyEnabled ? activeWarranty : null,
      warrantyTotal: warrantyEnabled ? warrantyRecords.length : null,
      warrantyEnabled,
    };
  });
}

module.exports = { enrichShopifyCustomers };
