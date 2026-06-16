"use strict";

const crypto = require('crypto');

function getSecret() {
  return String(process.env.PLATFORM_REVIEW_TOKEN_SECRET || process.env.JWT_SECRET || '').trim();
}

function b64urlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlDecode(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized;
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signPayload(payload) {
  const secret = getSecret();
  if (!secret) throw new Error('PLATFORM_REVIEW_TOKEN_SECRET missing');
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function buildPlatformReviewToken({ clientId, ratingPrefill = null }) {
  const body = {
    cid: String(clientId || '').trim(),
    r: ratingPrefill ? Number(ratingPrefill) : null,
    iat: Date.now(),
  };
  const encoded = b64urlEncode(JSON.stringify(body));
  const sig = signPayload(encoded);
  return `${encoded}.${sig}`;
}

function parsePlatformReviewToken(token) {
  const raw = String(token || '');
  const [encoded, sig] = raw.split('.');
  if (!encoded || !sig) return null;
  const expected = signPayload(encoded);
  if (expected !== sig) return null;
  let data = null;
  try {
    data = JSON.parse(b64urlDecode(encoded));
  } catch (_) {
    return null;
  }
  if (!data?.cid) return null;
  return {
    clientId: String(data.cid),
    ratingPrefill: data.r ? Number(data.r) : null,
    issuedAt: data.iat ? new Date(Number(data.iat)) : null,
  };
}

module.exports = {
  buildPlatformReviewToken,
  parsePlatformReviewToken,
};
