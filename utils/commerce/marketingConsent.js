const AdLead = require('../../models/AdLead');

/**
 * WhatsApp marketing consent rules (product policy — align with Meta opt-in docs).
 */

const { normalizePhone } = require('../core/helpers');

function normalizePhoneDigits(p, defaultCc = process.env.DEFAULT_COUNTRY_CODE || '91') {
  const country = String(defaultCc).length === 2 ? String(defaultCc).toUpperCase() : 'IN';
  return normalizePhone(p, country) || '';
}

function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return e.includes('@') ? e : '';
}

/** Business-initiated marketing / promo templates → only explicitly opted-in numbers. */
function shouldRequireMarketingOptIn(campaign) {
  if (!campaign) return false;
  const ch = (campaign.channel || 'whatsapp').toLowerCase();
  const cat = String(campaign.templateCategory || '').toUpperCase();
  if (cat === 'UTILITY' || cat === 'AUTHENTICATION') return false;
  if (ch === 'email') return true;
  if (ch !== 'whatsapp') return false;
  return true;
}

/** Mongo query fragment merged into AdLead queries for WhatsApp campaigns / broadcasts */
function mongoMarketingOptInOnly() {
  return { optStatus: 'opted_in' };
}

/** Email marketing — per-channel consent on AdLead */
function mongoEmailMarketingOptInOnly() {
  return { 'channelConsent.email.status': 'opted_in' };
}

function mongoEmailNotOptedOut() {
  return { 'channelConsent.email.status': { $ne: 'opted_out' } };
}

function audienceOptQueryForCampaign(campaign) {
  const ch = (campaign?.channel || 'whatsapp').toLowerCase();
  if (ch === 'email') {
    return shouldRequireMarketingOptIn(campaign) ? mongoEmailMarketingOptInOnly() : mongoEmailNotOptedOut();
  }
  return shouldRequireMarketingOptIn(campaign) ? mongoMarketingOptInOnly() : mongoNotOptedOut();
}

/** Never automate to people who explicitly opted out (includes missing field / unknown). */
function mongoNotOptedOut() {
  return {
    optStatus: { $ne: 'opted_out' },
  };
}

/** When tenant enables strict automation compliance */
function mongoCartRecoveryFilter(client) {
  const strict =
    client?.growthCompliance?.cartRecoveryRequiresOptIn === true;
  if (strict) return mongoMarketingOptInOnly();
  return mongoNotOptedOut();
}

/**
 * Filter audience rows (CSV / scheduled campaign) against AdLead.optStatus by phone match.
 */
async function filterAudienceForEmailOptIn(clientId, audienceRows, campaign) {
  if (!audienceRows?.length) return { rows: [], excluded: 0, reason: null };

  const rows = [...audienceRows];
  const emailSet = new Set();
  for (const row of rows) {
    const e = normalizeEmail(row?.email);
    if (e) emailSet.add(e);
  }
  if (emailSet.size === 0) return { rows: [], excluded: rows.length, reason: 'no_valid_email' };

  const leads = await AdLead.find({
    clientId,
    email: { $in: [...emailSet] },
  })
    .select('email channelConsent')
    .lean();

  const allowed = new Set();
  const requireOptIn = shouldRequireMarketingOptIn(campaign);
  for (const L of leads) {
    const e = normalizeEmail(L.email);
    if (!e) continue;
    const status = String(L.channelConsent?.email?.status || 'unknown').toLowerCase();
    if (requireOptIn) {
      if (status === 'opted_in') allowed.add(e);
    } else if (status !== 'opted_out') {
      allowed.add(e);
    }
  }

  const out = [];
  let excluded = 0;
  for (const row of rows) {
    const e = normalizeEmail(row?.email);
    if (!e || !allowed.has(e)) excluded++;
    else out.push(row);
  }
  return {
    rows: out,
    excluded,
    reason: excluded > 0 ? 'email_marketing_opt_in' : null,
  };
}

async function filterAudienceForMarketingOptIn(clientId, audienceRows, campaign) {
  const ch = (campaign?.channel || 'whatsapp').toLowerCase();
  if (ch === 'email') return filterAudienceForEmailOptIn(clientId, audienceRows, campaign);

  if (!shouldRequireMarketingOptIn(campaign))
    return { rows: audienceRows, excluded: 0, reason: null };

  if (!audienceRows?.length) return { rows: [], excluded: 0, reason: null };

  const rows = [...audienceRows];
  const phoneSet = new Set();
  for (const row of rows) {
    const raw = row?.phone || row?.phoneNumber || row?.number || row?.mobile || '';
    const p = normalizePhoneDigits(raw);
    if (p) phoneSet.add(p);
  }

  if (phoneSet.size === 0)
    return { rows: [], excluded: rows.length, reason: 'no_valid_phone' };

  const leads = await AdLead.find({
    clientId,
    phoneNumber: { $in: [...phoneSet] },
  })
    .select('phoneNumber optStatus')
    .lean();

  const allowed = new Set();
  for (const L of leads) {
    if (L.optStatus === 'opted_in') allowed.add(L.phoneNumber);
  }

  const out = [];
  let excluded = 0;
  for (const row of rows) {
    const raw = row?.phone || row?.phoneNumber || row?.number || row?.mobile || '';
    const p = normalizePhoneDigits(raw);
    if (!p || !allowed.has(p)) excluded++;
    else out.push(row);
  }

  return {
    rows: out,
    excluded,
    reason: excluded > 0 ? 'marketing_opt_in' : null,
  };
}

async function filterAudienceByOptStatus(clientId, audienceRows, allowedStatuses = []) {
  if (!audienceRows?.length) return { rows: [], excluded: 0, reason: null };
  const allowedSet = new Set((allowedStatuses || []).map((s) => String(s).toLowerCase()));
  if (allowedSet.size === 0) return { rows: audienceRows, excluded: 0, reason: null };

  const rows = [...audienceRows];
  const phoneSet = new Set();
  for (const row of rows) {
    const raw = row?.phone || row?.phoneNumber || row?.number || row?.mobile || '';
    const p = normalizePhoneDigits(raw);
    if (p) phoneSet.add(p);
  }
  if (phoneSet.size === 0) return { rows: [], excluded: rows.length, reason: 'no_valid_phone' };

  const leads = await AdLead.find({
    clientId,
    phoneNumber: { $in: [...phoneSet] },
  }).select('phoneNumber optStatus').lean();

  const allowedPhones = new Set(
    leads.filter((l) => allowedSet.has(String(l.optStatus || '').toLowerCase())).map((l) => l.phoneNumber)
  );

  const out = [];
  let excluded = 0;
  for (const row of rows) {
    const raw = row?.phone || row?.phoneNumber || row?.number || row?.mobile || '';
    const p = normalizePhoneDigits(raw);
    if (!p || !allowedPhones.has(p)) excluded++;
    else out.push(row);
  }
  return { rows: out, excluded, reason: excluded > 0 ? 'opt_status_filter' : null };
}

/**
 * Runtime hard gate before each outbound send.
 * Re-fetches current consent so status changes between schedule time and send time are respected.
 */
async function canSendToContact(clientId, leadLike, templateCategory) {
  const phoneRaw = leadLike?.phoneNumber || leadLike?.phone || leadLike?.number || leadLike?.mobile || '';
  const phone = normalizePhoneDigits(phoneRaw);
  if (!phone) return { canSend: false, reason: 'invalid_phone' };

  const currentLead = await AdLead.findOne({ clientId, phoneNumber: phone })
    .select('optStatus')
    .lean();
  if (!currentLead) return { canSend: false, reason: 'contact_not_found' };
  if (currentLead.optStatus === 'opted_out') return { canSend: false, reason: 'opted_out' };

  const cat = String(templateCategory || 'MARKETING').toUpperCase();
  if (cat === 'MARKETING' && currentLead.optStatus !== 'opted_in') {
    return { canSend: false, reason: 'not_opted_in_for_marketing' };
  }
  return { canSend: true, reason: null };
}

function evaluateLeadPolicy(optStatus, templateCategory = 'MARKETING') {
  const status = String(optStatus || 'unknown').toLowerCase();
  const cat = String(templateCategory || 'MARKETING').toUpperCase();
  if (status === 'opted_out') {
    return { canSend: false, reason: 'opted_out' };
  }
  if (cat === 'MARKETING' && status !== 'opted_in') {
    return { canSend: false, reason: 'not_opted_in_for_marketing' };
  }
  return { canSend: true, reason: null };
}

function evaluateAudiencePolicySummary(leads = [], templateCategory = 'MARKETING') {
  const summary = { total: leads.length, willSend: 0, optedOut: 0, unknownBlocked: 0 };
  for (const lead of leads) {
    const status = String(lead?.optStatus || 'unknown').toLowerCase();
    const decision = evaluateLeadPolicy(status, templateCategory);
    if (decision.canSend) {
      summary.willSend += 1;
    } else if (decision.reason === 'opted_out') {
      summary.optedOut += 1;
    } else {
      summary.unknownBlocked += 1;
    }
  }
  return summary;
}

module.exports = {
  normalizePhoneDigits,
  normalizeEmail,
  shouldRequireMarketingOptIn,
  mongoMarketingOptInOnly,
  mongoEmailMarketingOptInOnly,
  mongoEmailNotOptedOut,
  audienceOptQueryForCampaign,
  mongoNotOptedOut,
  mongoCartRecoveryFilter,
  filterAudienceForMarketingOptIn,
  filterAudienceForEmailOptIn,
  filterAudienceByOptStatus,
  canSendToContact,
  evaluateLeadPolicy,
  evaluateAudiencePolicySummary,
};
