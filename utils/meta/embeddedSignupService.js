'use strict';

/**
 * Embedded Signup v4 — service helpers.
 *
 * SECURITY RULES:
 *  - NEVER log access_token, code, or client_secret.
 *  - All errors returned as structured objects — token fields stripped.
 *  - idempotency cache: in-memory 60s (sufficient for single-request dedup).
 */

const axios = require('axios');
const crypto = require('crypto');
const log = require('../core/logger')('EmbeddedSignup');

const META_VERSION = process.env.META_API_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${META_VERSION}`;

// ─────────────────────────────────────────────────────────────────────────────
// Simple in-memory idempotency cache (60s TTL per code hash)
// ─────────────────────────────────────────────────────────────────────────────
const _codeCache = new Map();

function _cacheKey(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function _cacheGet(code) {
  const key = _cacheKey(code);
  const entry = _codeCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _codeCache.delete(key); return null; }
  return entry.result;
}

function _cacheSet(code, result, ttlMs = 60000) {
  _codeCache.set(_cacheKey(code), { result, expiresAt: Date.now() + ttlMs });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Exchange auth code for access token
// ─────────────────────────────────────────────────────────────────────────────
async function exchangeCodeForToken(code) {
  const cached = _cacheGet(code);
  if (cached) return cached;

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;

  if (!appId || !appSecret) {
    return { ok: false, category: 'other', message: 'META_APP_ID or META_APP_SECRET not configured on server.' };
  }

  try {
    const resp = await axios.post(
      `${GRAPH}/oauth/access_token`,
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        code,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );

    const data = resp.data;
    if (!data?.access_token) {
      return { ok: false, category: 'meta_api', message: 'Meta did not return an access token.' };
    }

    const result = { ok: true, accessToken: data.access_token, tokenType: data.token_type, expiresIn: data.expires_in };
    _cacheSet(code, result);
    return result;
  } catch (err) {
    const metaErr = err.response?.data?.error;
    log.error('Token exchange failed', { category: metaErr?.type || 'network', metaCode: metaErr?.code });
    return {
      ok: false,
      category: metaErr ? 'meta_api' : 'network',
      message: metaErr?.message || err.message || 'Token exchange request failed.',
      metaErrorCode: metaErr?.code || null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Validate token — GET /me
// ─────────────────────────────────────────────────────────────────────────────
async function validateToken(accessToken) {
  try {
    const resp = await axios.get(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { fields: 'id,name' },
      timeout: 10000,
    });
    if (!resp.data?.id) return { ok: false, category: 'meta_api', message: 'Token validation returned no user ID.' };
    return { ok: true, userId: resp.data.id, name: resp.data.name };
  } catch (err) {
    const metaErr = err.response?.data?.error;
    log.error('Token validation failed', { category: metaErr?.type || 'network', metaCode: metaErr?.code });
    return {
      ok: false,
      category: metaErr ? 'auth' : 'network',
      message: metaErr?.message || 'Token is invalid or expired.',
      metaErrorCode: metaErr?.code || null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Get WABA details — validate ownership
// ─────────────────────────────────────────────────────────────────────────────
async function getWABADetails(wabaId, accessToken) {
  try {
    const resp = await axios.get(`${GRAPH}/${encodeURIComponent(wabaId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { fields: 'id,name,currency,timezone_id,message_template_namespace' },
      timeout: 10000,
    });
    if (!resp.data?.id) return { ok: false, category: 'meta_api', message: 'WABA not found.' };
    return { ok: true, waba: resp.data };
  } catch (err) {
    const metaErr = err.response?.data?.error;
    return {
      ok: false,
      category: metaErr ? 'auth' : 'network',
      message: metaErr?.message || `Cannot access WABA ${wabaId} with this token.`,
      metaErrorCode: metaErr?.code || null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Get phone number details
// ─────────────────────────────────────────────────────────────────────────────
async function getPhoneNumberDetails(phoneNumberId, accessToken) {
  try {
    const resp = await axios.get(`${GRAPH}/${encodeURIComponent(phoneNumberId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { fields: 'id,display_phone_number,verified_name,quality_rating,platform_type,throughput' },
      timeout: 10000,
    });
    if (!resp.data?.id) return { ok: false, category: 'meta_api', message: 'Phone number not found.' };
    return {
      ok: true,
      phoneNumber: {
        id: resp.data.id,
        displayPhoneNumber: resp.data.display_phone_number,
        verifiedName: resp.data.verified_name,
        qualityRating: resp.data.quality_rating?.toUpperCase() || 'UNKNOWN',
        platformType: resp.data.platform_type,
      },
    };
  } catch (err) {
    const metaErr = err.response?.data?.error;
    return {
      ok: false,
      category: metaErr ? 'meta_api' : 'network',
      message: metaErr?.message || 'Cannot fetch phone number details.',
      metaErrorCode: metaErr?.code || null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Register phone number for Cloud API (skip for coexistence)
// ─────────────────────────────────────────────────────────────────────────────
async function registerPhoneNumber(phoneNumberId, accessToken, pin) {
  try {
    const resp = await axios.post(
      `${GRAPH}/${encodeURIComponent(phoneNumberId)}/register`,
      { messaging_product: 'whatsapp', pin },
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    if (resp.data?.success === true) return { ok: true };
    return { ok: false, category: 'meta_api', message: 'Phone registration returned non-success.' };
  } catch (err) {
    const metaErr = err.response?.data?.error;
    // 'Already registered' is not a failure — idempotent
    if (metaErr?.code === 100 && metaErr?.error_subcode === 2494010) {
      return { ok: true, alreadyRegistered: true };
    }
    return {
      ok: false,
      category: metaErr ? 'meta_api' : 'network',
      message: metaErr?.message || 'Phone registration failed.',
      metaErrorCode: metaErr?.code || null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Subscribe TopEdge app to WABA webhooks
// ─────────────────────────────────────────────────────────────────────────────
async function subscribeAppToWABA(wabaId, accessToken) {
  try {
    const resp = await axios.post(
      `${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    if (resp.data?.success === true) return { ok: true };
    return { ok: false, category: 'meta_api', message: 'WABA subscription returned non-success.' };
  } catch (err) {
    const metaErr = err.response?.data?.error;
    return {
      ok: false,
      category: metaErr ? 'meta_api' : 'network',
      message: metaErr?.message || 'Webhook subscription failed.',
      metaErrorCode: metaErr?.code || null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Unsubscribe app from WABA (used on disconnect)
// ─────────────────────────────────────────────────────────────────────────────
async function unsubscribeAppFromWABA(wabaId, accessToken) {
  try {
    const resp = await axios.delete(
      `${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 }
    );
    if (resp.data?.success === true) return { ok: true };
    return { ok: false, category: 'meta_api', message: 'Unsubscribe returned non-success.' };
  } catch (err) {
    const metaErr = err.response?.data?.error;
    return {
      ok: false,
      category: metaErr ? 'meta_api' : 'network',
      message: metaErr?.message || 'Unsubscribe failed.',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Generate a 6-digit numeric PIN for phone registration
// ─────────────────────────────────────────────────────────────────────────────
function generateRegistrationPin() {
  const buf = crypto.randomBytes(3);
  return String(parseInt(buf.toString('hex'), 16)).padStart(6, '0').slice(-6);
}

module.exports = {
  exchangeCodeForToken,
  validateToken,
  getWABADetails,
  getPhoneNumberDetails,
  registerPhoneNumber,
  subscribeAppToWABA,
  unsubscribeAppFromWABA,
  generateRegistrationPin,
};
