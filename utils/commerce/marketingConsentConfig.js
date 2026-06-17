'use strict';

/** Canonical marketing consent keywords + auto-reply defaults (tenant-overridable messages only). */

const DEFAULT_OPT_OUT_KEYWORDS = ['STOP', 'UNSUBSCRIBE'];
const DEFAULT_OPT_IN_KEYWORDS = ['START', 'SUBSCRIBE'];
const MAX_CUSTOM_OPT_OUT_KEYWORDS = 5;
const MAX_KEYWORD_LENGTH = 20;

const DEFAULT_OPT_OUT_AUTO_REPLY =
  "You've successfully unsubscribed from our WhatsApp updates about exclusive offers & many more... ❌\nWe'll miss you here, but don't worry you can type START/SUBSCRIBE anytime to join back!";

const DEFAULT_OPT_IN_AUTO_REPLY =
  "✅ You're now subscribed to our WhatsApp updates 🎉\nGet ready to receive exclusive offers, latest updates & more.";

function normalizeKeywordUpper(raw) {
  return String(raw || '').trim().toUpperCase();
}

function normalizeKeywordLower(raw) {
  return String(raw || '').trim().toLowerCase();
}

function escapeRegex(raw) {
  return String(raw || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isReservedOptOutKeyword(raw) {
  const u = normalizeKeywordUpper(raw);
  return DEFAULT_OPT_OUT_KEYWORDS.includes(u);
}

function isReservedOptInKeyword(raw) {
  const u = normalizeKeywordUpper(raw);
  return DEFAULT_OPT_IN_KEYWORDS.includes(u);
}

/**
 * Merchant-editable opt-out keywords only (excludes STOP / UNSUBSCRIBE).
 * Migrates legacy growthCompliance.stopKeywords when customOptOutKeywords is empty.
 */
function extractCustomOptOutKeywords(compliance = {}) {
  const reserved = new Set(DEFAULT_OPT_OUT_KEYWORDS);
  const raw =
    Array.isArray(compliance.customOptOutKeywords) && compliance.customOptOutKeywords.length
      ? compliance.customOptOutKeywords
      : Array.isArray(compliance.stopKeywords)
        ? compliance.stopKeywords
        : [];

  const out = [];
  for (const item of raw) {
    const kw = normalizeKeywordUpper(item);
    if (!kw || reserved.has(kw)) continue;
    if (kw.length > MAX_KEYWORD_LENGTH || /\s/.test(kw)) continue;
    if (!out.includes(kw)) out.push(kw);
    if (out.length >= MAX_CUSTOM_OPT_OUT_KEYWORDS) break;
  }
  return out;
}

function resolveOptOutKeywords(compliance = {}) {
  return [...DEFAULT_OPT_OUT_KEYWORDS, ...extractCustomOptOutKeywords(compliance)];
}

function resolveOptOutKeywordsLower(compliance = {}) {
  return resolveOptOutKeywords(compliance).map(normalizeKeywordLower);
}

function resolveOptInKeywordsLower() {
  return DEFAULT_OPT_IN_KEYWORDS.map(normalizeKeywordLower);
}

/** Case-insensitive: exact match or message starts with "{keyword} ". */
function matchesOptOutKeyword(text, compliance = {}) {
  const t = normalizeKeywordLower(text);
  if (!t) return false;
  const keywords = resolveOptOutKeywordsLower(compliance);
  return keywords.some((k) =>
    new RegExp(`^${escapeRegex(k)}(?:\\b|\\s|[_!.,?;:'"()\\-])`, 'i').test(t)
  );
}

/** Case-insensitive exact match or "{keyword} ..." */
function matchesOptInKeyword(text) {
  const t = normalizeKeywordLower(text);
  if (!t) return false;
  return resolveOptInKeywordsLower().some((k) =>
    new RegExp(`^${escapeRegex(k)}(?:\\b|\\s|[_!.,?;:'"()\\-])`, 'i').test(t)
  );
}

function getOptOutAutoReply(client) {
  const custom = client?.growthCompliance?.optOutAutoReplyMessage;
  const msg = String(custom || '').trim();
  return msg || DEFAULT_OPT_OUT_AUTO_REPLY;
}

function getOptInAutoReply(client) {
  const custom = client?.growthCompliance?.optInAutoReplyMessage;
  const msg = String(custom || '').trim();
  return msg || DEFAULT_OPT_IN_AUTO_REPLY;
}

function validateCustomOptOutKeywords(keywords) {
  if (!Array.isArray(keywords)) {
    return { ok: false, message: 'customOptOutKeywords must be an array.' };
  }
  if (keywords.length > MAX_CUSTOM_OPT_OUT_KEYWORDS) {
    return {
      ok: false,
      message: `You can add up to ${MAX_CUSTOM_OPT_OUT_KEYWORDS} custom opt-out keywords.`,
    };
  }
  for (const raw of keywords) {
    const kw = normalizeKeywordUpper(raw);
    if (!kw) continue;
    if (isReservedOptOutKeyword(kw) || isReservedOptInKeyword(kw)) {
      return {
        ok: false,
        message: `${kw} is a system keyword and cannot be added as a custom opt-out keyword.`,
      };
    }
    if (kw.length > MAX_KEYWORD_LENGTH || /\s/.test(kw)) {
      return {
        ok: false,
        message: 'Each opt-out keyword must be a single word with a maximum of 20 characters.',
      };
    }
  }
  return { ok: true, normalized: extractCustomOptOutKeywords({ customOptOutKeywords: keywords }) };
}

function serializeComplianceForApi(compliance = {}, widgetConfig = {}) {
  const customOptOutKeywords = extractCustomOptOutKeywords(compliance);
  return {
    cartRecoveryRequiresOptIn: compliance.cartRecoveryRequiresOptIn === true,
    defaultOptInPolicy: compliance.defaultOptInPolicy || 'single',
    applyPolicyToNewSignups: compliance.applyPolicyToNewSignups !== false,
    defaultOptOutKeywords: [...DEFAULT_OPT_OUT_KEYWORDS],
    customOptOutKeywords,
    /** @deprecated use customOptOutKeywords — kept for older clients */
    stopKeywords: [...DEFAULT_OPT_OUT_KEYWORDS, ...customOptOutKeywords],
    defaultOptInKeywords: [...DEFAULT_OPT_IN_KEYWORDS],
    optOutAutoReplyMessage:
      String(compliance.optOutAutoReplyMessage || '').trim() || DEFAULT_OPT_OUT_AUTO_REPLY,
    optInAutoReplyMessage:
      String(compliance.optInAutoReplyMessage || '').trim() || DEFAULT_OPT_IN_AUTO_REPLY,
    doubleOptInEnabled: widgetConfig?.doubleOptInEnabled === true,
  };
}

module.exports = {
  DEFAULT_OPT_OUT_KEYWORDS,
  DEFAULT_OPT_IN_KEYWORDS,
  MAX_CUSTOM_OPT_OUT_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  DEFAULT_OPT_OUT_AUTO_REPLY,
  DEFAULT_OPT_IN_AUTO_REPLY,
  normalizeKeywordUpper,
  normalizeKeywordLower,
  isReservedOptOutKeyword,
  isReservedOptInKeyword,
  extractCustomOptOutKeywords,
  resolveOptOutKeywords,
  resolveOptOutKeywordsLower,
  resolveOptInKeywordsLower,
  matchesOptOutKeyword,
  matchesOptInKeyword,
  getOptOutAutoReply,
  getOptInAutoReply,
  validateCustomOptOutKeywords,
  serializeComplianceForApi,
};
