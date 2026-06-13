'use strict';

const { normalizePhone } = require('../core/helpers');
const { phoneSuffixKey, normalizeEmailKey } = require('./customerIdentityMerge');

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
  const suffixSet = new Set();
  for (const c of shopifyCustomers) {
    const p = normalizePhone(c.phone);
    if (p) phoneSet.add(p);
    const ps = phoneSuffixKey(c.phone);
    if (ps) suffixSet.add(ps);
    const em = normalizeEmailKey(c.email);
    if (em) emailSet.add(em);
  }
  const phones = [...phoneSet];
  const emails = [...emailSet];
  const suffixes = [...suffixSet];

  const ScoreTierConfig = require('../../models/ScoreTierConfig');
  const { resolveScoreStageName } = require('../commerce/customerOrderMetrics');

  const tierDoc = await ScoreTierConfig.findOne({ clientId }).select('tiers').lean();
  const scoreTiers = tierDoc?.tiers?.length
    ? tierDoc.tiers
    : ScoreTierConfig.getDefaultConfig(clientId).tiers;

  const phoneOr = [{ phoneNumber: { $in: phones } }];
  for (const s of suffixes) {
    phoneOr.push({ phoneNumber: { $regex: `${s}$` } });
  }

  const [leadsByPhone, leadsByEmail] = await Promise.all([
    phones.length || suffixes.length
      ? AdLead.find({ clientId, $or: phoneOr })
          .select('phoneNumber email name leadScore warrantyRecords tags')
          .lean()
      : [],
    emails.length
      ? AdLead.find({ clientId, email: { $in: emails } })
          .select('phoneNumber email name leadScore warrantyRecords tags')
          .lean()
      : [],
  ]);

  const leadByPhoneSuffix = new Map();
  for (const lead of leadsByPhone || []) {
    const ps = phoneSuffixKey(lead.phoneNumber);
    if (ps && !leadByPhoneSuffix.has(ps)) leadByPhoneSuffix.set(ps, lead);
  }
  const leadByEmail = new Map();
  for (const lead of leadsByEmail || []) {
    const em = normalizeEmailKey(lead.email);
    if (em && !leadByEmail.has(em)) leadByEmail.set(em, lead);
  }

  return shopifyCustomers.map((c) => {
    const phone = normalizePhone(c.phone);
    const email = normalizeEmailKey(c.email);
    const lead =
      (phoneSuffixKey(phone) && leadByPhoneSuffix.get(phoneSuffixKey(phone))) ||
      (email && leadByEmail.get(email)) ||
      null;

    const warrantyRecords = lead?.warrantyRecords || [];
    const activeWarranty = warrantyRecords.filter((w) => w.status === 'active').length;

    const leadPhone = normalizePhone(lead?.phoneNumber);
    const shopifyPhone = normalizePhone(c.phone);
    const leadEmail = normalizeEmailKey(lead?.email);
    const linkedPhones = [];
    if (leadPhone) {
      linkedPhones.push(leadPhone);
      if (shopifyPhone && phoneSuffixKey(shopifyPhone) === phoneSuffixKey(leadPhone)) {
        linkedPhones.push(shopifyPhone);
      }
    } else if (shopifyPhone) {
      linkedPhones.push(shopifyPhone);
    }
    const linkedEmails = [...new Set([email, leadEmail].filter(Boolean))];

    return {
      ...c,
      phone: leadPhone || shopifyPhone || c.phone || null,
      workspacePhone: leadPhone || shopifyPhone || null,
      linkedPhones: [...new Set(linkedPhones.filter(Boolean))],
      linkedEmails,
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
