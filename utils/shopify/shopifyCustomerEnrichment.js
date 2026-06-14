'use strict';

const { normalizePhone, formatPhoneForDisplay } = require('../core/helpers');
const { pickCanonicalPhone } = require('../core/phoneSanitizer');
const {
  phoneSuffixKey,
  normalizeEmailKey,
  loadWarrantySignalsByIdentity,
  resolveWarrantyForCustomer,
} = require('./shopifyCustomerWorkspaceSignals');

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

function mergeWarrantyCounts(warrantyEnabled, canonical, legacyRecords) {
  if (!warrantyEnabled) {
    return { warrantyTotal: null, warrantyActive: null };
  }
  const legacyTotal = Array.isArray(legacyRecords) ? legacyRecords.length : 0;
  const legacyActive = Array.isArray(legacyRecords)
    ? legacyRecords.filter((w) => w.status === 'active').length
    : 0;
  const canonicalTotal = canonical?.total || 0;
  const canonicalActive = canonical?.active || 0;
  return {
    warrantyTotal: Math.max(canonicalTotal, legacyTotal),
    warrantyActive: Math.max(canonicalActive, legacyActive),
  };
}

function shopifyCustomerCountry(customer) {
  const code = customer?.default_address?.country_code || customer?.default_address?.country;
  if (code && String(code).trim().length === 2) {
    return String(code).trim().toUpperCase();
  }
  return 'IN';
}

/**
 * Attach TopEdge workspace signals (warranty, lead) to Shopify customers.
 * Warranty uses canonical WarrantyRecord + Contact, with legacy AdLead fallback.
 * @param {string} clientId
 * @param {object[]} shopifyCustomers
 */
async function enrichShopifyCustomers(clientId, shopifyCustomers = [], preloadedWarrantyMaps = null) {
  if (!clientId) return shopifyCustomers;
  if (!Array.isArray(shopifyCustomers)) return [];

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
    const custCountry = shopifyCustomerCountry(c);
    const p = normalizePhone(c.phone, custCountry);
    if (p) phoneSet.add(p);
    const ps = phoneSuffixKey(c.phone);
    if (ps) suffixSet.add(ps);
    const em = normalizeEmailKey(c.email);
    if (em) emailSet.add(em);
    for (const lp of c.linkedPhones || []) {
      const n = normalizePhone(lp, custCountry);
      if (n) phoneSet.add(n);
      const lps = phoneSuffixKey(lp);
      if (lps) suffixSet.add(lps);
    }
    for (const le of c.linkedEmails || []) {
      const ek = normalizeEmailKey(le);
      if (ek) emailSet.add(ek);
    }
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
    if (/^[6-9]\d{9}$/.test(s)) {
      phoneOr.push({ phoneNumber: { $regex: `${s}$` } });
    }
  }

  const [leadsByPhone, leadsByEmail, warrantyMaps] = await Promise.all([
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
    preloadedWarrantyMaps != null
      ? Promise.resolve(preloadedWarrantyMaps)
      : warrantyEnabled
        ? loadWarrantySignalsByIdentity(clientId)
        : Promise.resolve(null),
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
    const custCountry = shopifyCustomerCountry(c);
    const phone = normalizePhone(c.phone, custCountry);
    const email = normalizeEmailKey(c.email);
    const lead =
      (phoneSuffixKey(phone) && leadByPhoneSuffix.get(phoneSuffixKey(phone))) ||
      (email && leadByEmail.get(email)) ||
      null;

    const leadPhone = normalizePhone(lead?.phoneNumber, 'IN');
    const shopifyPhone = normalizePhone(c.phone, custCountry);
    const leadEmail = normalizeEmailKey(lead?.email);
    const linkedPhones = [];
    if (shopifyPhone) linkedPhones.push(shopifyPhone);
    if (leadPhone && leadPhone !== shopifyPhone) linkedPhones.push(leadPhone);
    const linkedEmails = [...new Set([email, leadEmail].filter(Boolean))];

    const canonicalDigits = pickCanonicalPhone(
      [shopifyPhone, leadPhone, ...(c.linkedPhones || [])],
      { country: custCountry }
    );

    const displayPhone =
      formatPhoneForDisplay(c.phone, custCountry) ||
      (canonicalDigits ? formatPhoneForDisplay(canonicalDigits, custCountry) : null) ||
      (canonicalDigits ? canonicalDigits : null);

    const draft = {
      ...c,
      phone: displayPhone,
      phoneNormalized: canonicalDigits || null,
      workspacePhone: canonicalDigits || null,
      linkedPhones: [...new Set(linkedPhones.filter(Boolean))],
      linkedEmails,
    };

    const canonicalWarranty = warrantyMaps
      ? resolveWarrantyForCustomer(draft, warrantyMaps)
      : null;
    const { warrantyTotal, warrantyActive } = mergeWarrantyCounts(
      warrantyEnabled,
      canonicalWarranty,
      lead?.warrantyRecords
    );

    return {
      ...draft,
      leadId: lead?._id ? String(lead._id) : c.leadId || null,
      leadName: lead?.name || c.leadName || null,
      leadScore: lead?.leadScore ?? c.leadScore ?? null,
      scoreStageName: resolveScoreStageName(lead?.leadScore ?? c.leadScore ?? 0, scoreTiers),
      tags: normalizeTagsArray(lead?.tags ?? c.tags),
      contactId: canonicalWarranty?.contactId || c.contactId || null,
      warrantyActive,
      warrantyTotal,
      warrantyEnabled,
    };
  });
}

module.exports = { enrichShopifyCustomers, mergeWarrantyCounts };
