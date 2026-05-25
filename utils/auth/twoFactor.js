'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function generateSecret() {
  const buf = crypto.randomBytes(20);
  const base32 = buf.toString('base64').replace(/=/g, '').replace(/\+/g, '').replace(/\//g, '').slice(0, 32);
  return base32;
}

function verifyTotp(secret, token, window = 1) {
  const speakeasy = trySpeakeasy();
  if (speakeasy) {
    return speakeasy.totp.verify({ secret, encoding: 'base32', token: String(token), window });
  }
  return verifyTotpNative(secret, token, window);
}

function trySpeakeasy() {
  try {
    return require('speakeasy');
  } catch {
    return null;
  }
}

function verifyTotpNative(secret, token, window) {
  const step = 30;
  const now = Math.floor(Date.now() / 1000);
  for (let w = -window; w <= window; w += 1) {
    const counter = Math.floor((now + w * step) / step);
    const expected = hotp(secret, counter);
    if (expected === String(token).padStart(6, '0')) return true;
  }
  return false;
}

function hotp(secret, counter) {
  const key = Buffer.from(secret.replace(/\s/g, ''), 'ascii');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

function otpauthUrl(email, secret) {
  const label = encodeURIComponent(`TopEdge:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=TopEdge`;
}

async function hashRecoveryCodes(codes) {
  const out = [];
  for (const c of codes) {
    out.push(await bcrypt.hash(c, 12));
  }
  return out;
}

async function consumeRecoveryCode(user, code) {
  const hashes = user.twoFactorRecoveryCodes || [];
  for (let i = 0; i < hashes.length; i += 1) {
    if (await bcrypt.compare(code, hashes[i])) {
      hashes.splice(i, 1);
      user.twoFactorRecoveryCodes = hashes;
      return true;
    }
  }
  return false;
}

function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => crypto.randomBytes(5).toString('hex'));
}

module.exports = {
  generateSecret,
  verifyTotp,
  otpauthUrl,
  hashRecoveryCodes,
  consumeRecoveryCode,
  generateRecoveryCodes,
};
