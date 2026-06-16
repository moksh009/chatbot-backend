'use strict';

const REQUIRED = ['JWT_SECRET'];

function getSecret(name) {
  const v = process.env[name];
  if (v == null || String(v).trim() === '') {
    throw new Error(`Missing required secret: ${name}`);
  }
  return String(v).trim();
}

function resolveFieldEncryptionKey() {
  const key =
    process.env.FIELD_ENCRYPTION_KEY ||
    process.env.ENCRYPTION_KEY ||
    '';
  return String(key).trim();
}

function validateSecretsAtBoot() {
  const strict =
    process.env.NODE_ENV === 'production' ||
    process.env.SECURITY_STRICT === 'true';
  if (!strict) return;
  for (const name of REQUIRED) {
    getSecret(name);
  }
  const key = resolveFieldEncryptionKey();
  if (!key) {
    throw new Error(
      'Missing required secret: FIELD_ENCRYPTION_KEY (or legacy ENCRYPTION_KEY)'
    );
  }
  if (Buffer.from(key, 'utf8').length < 32) {
    throw new Error('FIELD_ENCRYPTION_KEY must be at least 32 bytes');
  }
  if (!process.env.FIELD_ENCRYPTION_KEY && process.env.ENCRYPTION_KEY) {
    process.env.FIELD_ENCRYPTION_KEY = key;
  }
}

module.exports = { getSecret, validateSecretsAtBoot, REQUIRED, resolveFieldEncryptionKey };
