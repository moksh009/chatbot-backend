const AdLead = require('../../models/AdLead');

/**
 * WhatsApp marketing consent rules (product policy — align with Meta opt-in docs).
 */

const { normalizePhone } = require('../core/helpers');

/** Map env dial codes (e.g. "91") and ISO codes (e.g. "IN") to libphonenumber region. */
function resolvePhoneRegion(defaultCc = process.env.DEFAULT_COUNTRY_CODE || '91') {
  const raw = String(defaultCc || '').trim().toUpperCase();
  if (raw === 'IN' || raw === 'IND' || raw === 'INDIA') return 'IN';
  // Numeric dial codes (91, 1, …) — TopEdge V1 defaults to Indian merchants
  if (/^\d{1,3}$/.test(raw)) return 'IN';
  if (raw.length === 2 && /^[A-Z]{2}$/.test(raw)) return raw;
  return 'IN';
}

function normalizePhoneDigits(p, defaultCc = process.env.DEFAULT_COUNTRY_CODE || '91') {
  const country = resolvePhoneRegion(defaultCc);
  const normalized = normalizePhone(p, country);
  if (normalized) return normalized;
  // Fallback for already-normalized E.164 digits stored by legacy CSV upload paths
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return '';
}

function normalizeEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return e.includes('@') ? e : '';
}

/** When false, marketing sends to all contacts except explicit opt-outs. */
function shouldRequireMarketingOptIn() {
  return false;
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

/** Terminal cart states — cron must not message these leads (Phase 5). */
function mongoCartRecoveryTerminalExclusions() {
  return {
    isOrderPlaced: { $ne: true },
    suppressRecovery: { $ne: true },
    cartStatus: { $nin: ['purchased', 'recovered', 'suppressed'] },
  };
}

/** When tenant enables strict automation compliance */
function mongoCartRecoveryFilter(client) {
  const strict =
    client?.growthCompliance?.cartRecoveryRequiresOptIn === true;
  const consent = strict ? mongoMarketingOptInOnly() : mongoNotOptedOut();
  return {
    ...consent,
    ...mongoCartRecoveryTerminalExclusions(),
  };
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
    if (!e) {
      excluded++;
      continue;
    }
    if (allowed.has(e)) {
      out.push(row);
      continue;
    }
    // Cold CSV / frozen-list emails with no AdLead yet — sendable when opt-in not required
    if (!requireOptIn) {
      out.push(row);
      continue;
    }
    excluded++;
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

  const { phoneVariants } = require('../messaging/cancelAllAutomationsFor');
  const variants = phoneVariants(phone);
  const currentLead = await AdLead.findOne({
    clientId,
    phoneNumber: variants.length ? { $in: variants } : phone,
  })
    .select('optStatus channelConsent.whatsapp.status')
    .lean();
  if (!currentLead) return { canSend: true, reason: null };
  const status = String(
    currentLead.channelConsent?.whatsapp?.status || currentLead.optStatus || 'opted_in'
  ).toLowerCase();
  if (status === 'opted_out') return { canSend: false, reason: 'opted_out' };
  return { canSend: true, reason: null };
}

async function isLeadOptedOutForSend(clientId, phone) {
  const gate = await canSendToContact(clientId, { phoneNumber: phone });
  return gate.canSend === false && gate.reason === 'opted_out';
}

function evaluateLeadPolicy(optStatus) {
  const status = String(optStatus || 'unknown').toLowerCase();
  if (status === 'opted_out') {
    return { canSend: false, reason: 'opted_out' };
  }
  return { canSend: true, reason: null };
}

function evaluateAudiencePolicySummary(leads = [], templateCategory = 'MARKETING') {
  const summary = { total: leads.length, willSend: 0, optedOut: 0, unknownBlocked: 0 };
  for (const lead of leads) {
    const status = String(lead?.optStatus || 'unknown').toLowerCase();
    const decision = evaluateLeadPolicy(status);
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
  isLeadOptedOutForSend,
  evaluateLeadPolicy,
  evaluateAudiencePolicySummary,
};
