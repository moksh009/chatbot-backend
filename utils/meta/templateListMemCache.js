'use strict';

/**
 * In-process cache for GET /api/templates/list (Phase 4.2).
 * Avoids 40s+ Mongo merges on repeat Meta Manager / shell opens.
 * Invalidated on template sync, status change, and purpose patch.
 */

const templateListMemCache = new Map();

/** Default list TTL — was 45s (June 2026 audit). */
const TEMPLATE_LIST_MEM_TTL_MS = 120_000;
/** Meta Manager `contextPurpose=manager` — hottest path (shell + library). */
const TEMPLATE_LIST_MEM_TTL_MANAGER_MS = 180_000;
/** skipCanonical / liveChat fast path. */
const TEMPLATE_LIST_MEM_TTL_FAST_MS = 120_000;

function templateListMemKey(clientId, contextSuffix) {
  return `${clientId || ''}:${contextSuffix || '*'}`;
}

function readTemplateListMemCache(key) {
  const row = templateListMemCache.get(key);
  if (!row || row.exp < Date.now()) {
    if (row) templateListMemCache.delete(key);
    return null;
  }
  return row.body;
}

function writeTemplateListMemCache(key, body, ttlMs) {
  const ttl = Number(ttlMs) > 0 ? ttlMs : TEMPLATE_LIST_MEM_TTL_MS;
  templateListMemCache.set(key, { exp: Date.now() + ttl, body });
}

function invalidateTemplateListMemCache(clientId) {
  if (!clientId) {
    templateListMemCache.clear();
    return;
  }
  const prefix = `${clientId}:`;
  for (const key of templateListMemCache.keys()) {
    if (key.startsWith(prefix)) {
      templateListMemCache.delete(key);
    }
  }
}

function resolveTemplateListMemTtl({ skipCanonical, contextPurpose } = {}) {
  if (skipCanonical) return TEMPLATE_LIST_MEM_TTL_FAST_MS;
  if (contextPurpose === 'manager') return TEMPLATE_LIST_MEM_TTL_MANAGER_MS;
  return TEMPLATE_LIST_MEM_TTL_MS;
}

module.exports = {
  TEMPLATE_LIST_MEM_TTL_MS,
  TEMPLATE_LIST_MEM_TTL_MANAGER_MS,
  TEMPLATE_LIST_MEM_TTL_FAST_MS,
  templateListMemKey,
  readTemplateListMemCache,
  writeTemplateListMemCache,
  invalidateTemplateListMemCache,
  resolveTemplateListMemTtl,
};
