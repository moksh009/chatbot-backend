'use strict';

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';

function getKeys() {
  const raw = process.env.FIELD_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || '';
  const current = Buffer.from(raw.padEnd(32, '0').slice(0, 32));
  const prevRaw = process.env.FIELD_ENCRYPTION_KEY_PREVIOUS || '';
  const previous = prevRaw ? Buffer.from(prevRaw.padEnd(32, '0').slice(0, 32)) : null;
  return { current, previous };
}

function encryptValue(plain) {
  if (plain == null || plain === '') return plain;
  const str = String(plain);
  if (str.startsWith(PREFIX)) return str;
  const { current } = getKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, current, iv);
  const enc = Buffer.concat([cipher.update(str, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptValue(stored) {
  if (stored == null || stored === '') return stored;
  const str = String(stored);
  if (!str.startsWith(PREFIX)) return str;
  const body = str.slice(PREFIX.length);
  const [ivHex, tagHex, dataHex] = body.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const { current, previous } = getKeys();
  for (const key of [current, previous].filter(Boolean)) {
    try {
      const decipher = crypto.createDecipheriv(ALGO, key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch (_) {
      /* try previous key */
    }
  }
  return '';
}

function fieldEncryption(schema, { fields = [] } = {}) {
  for (const path of fields) {
    schema.path(path).get(function decryptField(v) {
      return decryptValue(v);
    });
    schema.path(path).set(function encryptField(v) {
      return encryptValue(v);
    });
  }
}

module.exports = { fieldEncryption, encryptValue, decryptValue, PREFIX };
