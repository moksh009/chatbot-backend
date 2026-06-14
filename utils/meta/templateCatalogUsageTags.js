'use strict';

const catalog = require('../../constants/templateCatalog/template-catalog.json');

const CATALOG_USAGE_TAGS = new Set();

function addCatalogTag(tag) {
  const clean = String(tag || '').trim();
  if (clean) CATALOG_USAGE_TAGS.add(clean);
}

for (const group of catalog.groups || []) {
  for (const slot of group.slots || []) {
    for (const usedIn of slot.usedIn || []) addCatalogTag(usedIn);
    for (const name of slot.metaNames || []) {
      if (name) addCatalogTag(name);
    }
  }
}
addCatalogTag('Pre-built');

/** @type {Map<string, Set<string>>} */
const tagToMetaNames = new Map();

function registerNameForTag(tag, name) {
  const cleanTag = String(tag || '').trim();
  const cleanName = String(name || '').trim().toLowerCase();
  if (!cleanTag || !cleanName) return;
  if (!tagToMetaNames.has(cleanTag)) tagToMetaNames.set(cleanTag, new Set());
  tagToMetaNames.get(cleanTag).add(cleanName);
}

for (const group of catalog.groups || []) {
  for (const slot of group.slots || []) {
    const names = new Set();
    if (slot.canonicalMetaName) names.add(String(slot.canonicalMetaName).toLowerCase());
    for (const n of slot.metaNames || []) names.add(String(n).toLowerCase());
    for (const name of names) {
      registerNameForTag('Pre-built', name);
      for (const usedIn of slot.usedIn || []) registerNameForTag(usedIn, name);
    }
  }
}

for (const [alias, target] of Object.entries(catalog.nameAliases || {})) {
  const targetLower = String(target).toLowerCase();
  for (const [tag, names] of tagToMetaNames.entries()) {
    if (names.has(targetLower)) registerNameForTag(tag, alias);
  }
}

function isCatalogUsageTag(tag) {
  return CATALOG_USAGE_TAGS.has(String(tag || '').trim());
}

function getAllCatalogUsageTags() {
  const tags = Array.from(CATALOG_USAGE_TAGS).filter((t) => t !== 'Pre-built');
  tags.sort((a, b) => a.localeCompare(b));
  return ['Pre-built', ...tags];
}

function getCatalogMetaNamesForUsageTags(tagFilters = []) {
  const names = new Set();
  for (const tag of tagFilters) {
    const clean = String(tag || '').trim();
    const bucket = tagToMetaNames.get(clean);
    if (bucket) {
      for (const n of bucket) names.add(n);
    }
  }
  return Array.from(names);
}

module.exports = {
  isCatalogUsageTag,
  getAllCatalogUsageTags,
  getCatalogMetaNamesForUsageTags,
};
