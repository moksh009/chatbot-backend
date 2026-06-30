"use strict";

const { decrypt } = require('../core/encryption');

/** Heuristic: values encrypted by utils/core/encryption.js look like `<32 hex iv>:<hex ciphertext>`. */
function looksLikeAppEncryptedToken(val) {
  if (typeof val !== "string" || !val.includes(":")) return false;
  const [ivHex, dataHex] = val.split(":");
  return (
    ivHex &&
    ivHex.length === 32 &&
    /^[0-9a-f]+$/i.test(ivHex) &&
    dataHex &&
    /^[0-9a-f]+$/i.test(dataHex)
  );
}

function maybeDecryptSecret(value) {
  if (value == null) return "";
  const s = String(value).trim();
  if (!s) return "";
  if (looksLikeAppEncryptedToken(s)) {
    const d = decrypt(s);
    // Never pass iv:ciphertext blobs to Meta — treat failed decrypt as absent so callers fall back.
    if (d && !looksLikeAppEncryptedToken(d)) return d;
    return "";
  }
  return s;
}

/**
 * Mongoose .select() for any outbound WhatsApp send / envelope dispatch.
 * Includes legacy nested paths (whatsapp.*, config.*) and premium overrides.
 *
 * Never include bare `config` here — Client.config is Schema.Types.Mixed and
 * selecting both `config` + `config.*` throws "Path collision at config".
 */
const WHATSAPP_CREDENTIAL_SELECT =
  "clientId phoneNumberId wabaId whatsappToken premiumAccessToken premiumPhoneId whatsapp.phoneNumberId whatsapp.wabaId whatsapp.accessToken config.phoneNumberId config.wabaId config.whatsappToken whatsappConnectionType whatsappConnectionMethod complianceConfig flags syncedMetaTemplates instagramAccessToken igAccessToken social.instagram.accessToken name email translationConfig geminiApiKey";

/** For connection health / status routes — includes display fields + credentials (no parent+child path collision). */
const WHATSAPP_CONNECTION_STATUS_SELECT =
  WHATSAPP_CREDENTIAL_SELECT +
  " whatsappDisplayPhoneNumber whatsappVerifiedName whatsappQualityRating whatsappWebhookSubscribed " +
  "whatsappCoexistence whatsappConnectedAt whatsappAccountStatus whatsappRestricted whatsappMessagingLimit whatsappOnboardingCompleted";

/** Mongoose .select() for outbound email / envelope dispatch (Gmail OAuth + SMTP). */
const EMAIL_CREDENTIAL_SELECT =
  "clientId emailMethod gmailAddress emailUser gmailRefreshToken gmailAccessToken " +
  "emailAppPassword emailHost emailPort emailSecure name translationConfig";

/** True when a string can be sent to Meta Graph (not empty, not an undecrypted blob). */
function isUsableGraphAccessToken(token) {
  if (!token || typeof token !== "string") return false;
  const s = token.trim();
  if (s.length < 20) return false;
  if (looksLikeAppEncryptedToken(s)) return false;
  return true;
}

/** All decrypted token candidates in storage precedence order (deduped). */
function collectWhatsAppTokenCandidates(client) {
  if (!client) return [];
  const raw = [
    client.premiumAccessToken,
    client.whatsappToken,
    client.whatsapp?.accessToken,
    client.config?.whatsappToken,
  ];
  const out = [];
  const seen = new Set();
  for (const val of raw) {
    const t = maybeDecryptSecret(val);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/**
 * Bearer token for Graph API — first usable candidate across all storage paths.
 * Skips empty values and undecrypted iv:ciphertext blobs so a bad premium token
 * does not block a valid root whatsappToken fallback.
 */
function getEffectiveWhatsAppAccessToken(client) {
  const candidates = collectWhatsAppTokenCandidates(client);
  return candidates.find(isUsableGraphAccessToken) || "";
}

/**
 * Phone number ID for /v21.0/{id}/messages — premium → root → nested → config.
 */
function getEffectiveWhatsAppPhoneNumberId(client) {
  if (!client) return "";
  return (
    String(client.premiumPhoneId || "").trim() ||
    String(client.phoneNumberId || "").trim() ||
    String(client.whatsapp?.phoneNumberId || "").trim() ||
    String(client.config?.phoneNumberId || "").trim() ||
    ""
  );
}

/** WABA id — root → nested → config. */
function getEffectiveWhatsAppWabaId(client) {
  if (!client) return "";
  return (
    String(client.wabaId || "").trim() ||
    String(client.whatsapp?.wabaId || "").trim() ||
    String(client.config?.wabaId || "").trim() ||
    ""
  );
}

/**
 * Resolved credentials for sends + connection checks (single source of truth).
 */
function resolveWhatsAppCredentials(client) {
  return {
    token: getEffectiveWhatsAppAccessToken(client),
    phoneNumberId: getEffectiveWhatsAppPhoneNumberId(client),
    wabaId: getEffectiveWhatsAppWabaId(client),
    connectionType: client?.whatsappConnectionType || "",
    connectionMethod: client?.whatsappConnectionMethod || "",
  };
}

/** True when outbound WhatsApp Cloud API calls can be made for this tenant. */
function isWhatsAppOutboundReady(client) {
  const { token, phoneNumberId, wabaId } = resolveWhatsAppCredentials(client);
  return !!(token && token.length > 5 && phoneNumberId && wabaId);
}

/**
 * Mirror credential writes to all legacy storage paths so manual + embedded signup
 * stay compatible after switching connection methods.
 */
function buildWhatsAppCredentialMirror({ phoneNumberId, wabaId, accessToken } = {}) {
  const set = {};
  if (phoneNumberId) {
    const pid = String(phoneNumberId).trim();
    set.phoneNumberId = pid;
    set["whatsapp.phoneNumberId"] = pid;
    set["config.phoneNumberId"] = pid;
  }
  if (wabaId) {
    const wid = String(wabaId).trim();
    set.wabaId = wid;
    set["whatsapp.wabaId"] = wid;
    set["config.wabaId"] = wid;
  }
  if (accessToken) {
    const tok = String(accessToken).trim();
    set.whatsappToken = tok;
    set["whatsapp.accessToken"] = tok;
    set["config.whatsappToken"] = tok;
  }
  return set;
}

/**
 * Mongo filter for inbound webhook routing when Meta sends metadata.phone_number_id.
 */
function phoneNumberIdMatchFilter(phoneNumberId) {
  const pid = String(phoneNumberId || "").trim();
  if (!pid) return null;
  return {
    $or: [
      { phoneNumberId: pid },
      { "whatsapp.phoneNumberId": pid },
      { "wabaAccounts.phoneNumberId": pid },
      { "config.phoneNumberId": pid },
    ],
  };
}

/**
 * Tokens that may read Meta Commerce catalog (/{catalog-id}/products).
 * Order: dedicated catalog token → Meta Ads/Business token → WhatsApp token.
 */
function getMetaCatalogAccessTokens(client) {
  if (!client) return [];
  const seen = new Set();
  const out = [];
  const push = (val) => {
    const t = maybeDecryptSecret(val);
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  push(client.metaCatalogAccessToken);
  push(client.metaAdsToken);
  push(client.social?.metaAds?.accessToken);
  push(client.premiumAccessToken);
  push(client.whatsappToken);
  push(client.whatsapp?.accessToken);
  push(client.config?.whatsappToken);
  return out;
}

module.exports = {
  WHATSAPP_CREDENTIAL_SELECT,
  WHATSAPP_CONNECTION_STATUS_SELECT,
  EMAIL_CREDENTIAL_SELECT,
  maybeDecryptSecret,
  looksLikeAppEncryptedToken,
  isUsableGraphAccessToken,
  collectWhatsAppTokenCandidates,
  getEffectiveWhatsAppAccessToken,
  getEffectiveWhatsAppPhoneNumberId,
  getEffectiveWhatsAppWabaId,
  resolveWhatsAppCredentials,
  isWhatsAppOutboundReady,
  buildWhatsAppCredentialMirror,
  getMetaCatalogAccessTokens,
  phoneNumberIdMatchFilter,
};
