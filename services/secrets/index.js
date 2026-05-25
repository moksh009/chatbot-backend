'use strict';

const REQUIRED = ['JWT_SECRET', 'FIELD_ENCRYPTION_KEY'];

function getSecret(name) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') {
    throw new Error(`Missing required secret: ${name}`);
  }
  return String(v).trim();
}

function validateSecretsAtBoot() {
  const strict =
    process.env.NODE_ENV === 'production' ||
    process.env.SECURITY_STRICT === 'true';
  if (!strict) return;
  for (const name of REQUIRED) {
    getSecret(name);
  }
  const key = process.env.FIELD_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
  if (!key || Buffer.from(key, 'utf8').length < 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must be at least 32 bytes');
  }
}

module.exports = { getSecret, validateSecretsAtBoot, REQUIRED };
