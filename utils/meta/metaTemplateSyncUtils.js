'use strict';

/** Meta Graph API returns last_updated_time as ISO string or unix seconds. */
function parseMetaLastEdited(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeMetaCategory(raw) {
  const c = String(raw || '').trim().toUpperCase();
  if (c === 'MARKETING' || c === 'UTILITY' || c === 'AUTHENTICATION') return c;
  return null;
}

const META_TEMPLATE_LIST_FIELDS =
  'name,status,category,language,components,last_updated_time,id';

module.exports = {
  parseMetaLastEdited,
  normalizeMetaCategory,
  META_TEMPLATE_LIST_FIELDS,
};
