const crypto = require('crypto');

function hashShort(text = '') {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

function resolveWindowBucket(intent) {
  const nowSec = Math.floor(Date.now() / 1000);
  if (intent === 'marketing') return { bucket: Math.floor(nowSec / 3600), ttlSec: 7200 };
  if (intent === 'transactional') return { bucket: Math.floor(nowSec / 60), ttlSec: 120 };
  if (intent === 'service') return { bucket: Math.floor(nowSec / 300), ttlSec: 600 };
  return { bucket: Math.floor(nowSec / 300), ttlSec: 300 };
}

function generateIdempotencyKey({ clientId, contactId, channel, intent, payload = {}, step = '' }) {
  const stableText = payload.templateName || hashShort(payload.text || payload.subject || '');
  const { bucket } = resolveWindowBucket(intent);
  const raw = `${clientId}:${contactId || 'na'}:${channel}:${intent}:${stableText}:${bucket}:${step || ''}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

module.exports = {
  hashShort,
  resolveWindowBucket,
  generateIdempotencyKey,
};
