'use strict';

const { inferProductFromUrl } = require('./productViewUrlUtils');

/**
 * Resolve the best available URL/path for a pixel event (web pixel often omits href).
 */
function resolvePixelEventUrl(payload = {}, doc = {}) {
  const meta = { ...(doc.metadata || {}), ...(payload.metadata || {}) };
  const candidates = [
    payload.url,
    doc.url,
    meta.url,
    meta.href,
    meta.pathname,
    payload.pathname,
  ]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (inferProductFromUrl(candidate) || candidate.startsWith('http') || candidate.startsWith('/')) {
      return candidate;
    }
  }
  return candidates[0] || '';
}

function enrichPixelMetadata(payload = {}, doc = {}) {
  const metadata = { ...(payload.metadata || {}), ...(doc.metadata || {}) };
  const url = resolvePixelEventUrl(payload, doc);
  if (url) {
    metadata.url = metadata.url || url;
    if (!metadata.pathname && url.startsWith('/')) {
      metadata.pathname = url.split('?')[0].split('#')[0];
    }
  }
  if (payload.shopifyClientId && !metadata.shopifyClientId) {
    metadata.shopifyClientId = payload.shopifyClientId;
  }
  if (payload.visitorId && !metadata.visitorId) {
    metadata.visitorId = payload.visitorId;
  }
  return { url, metadata };
}

module.exports = {
  resolvePixelEventUrl,
  enrichPixelMetadata,
};
