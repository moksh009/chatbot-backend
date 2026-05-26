"use strict";

const path = require("path");
const fs = require("fs");

function resolveCatalogPath() {
  const envPath = process.env.TEMPLATE_CATALOG_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const candidates = [
    path.join(__dirname, "template-catalog.json"),
    path.join(__dirname, "../../data/template-catalog.json"),
    path.join(__dirname, "../../../shared/template-catalog.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `template-catalog.json not found. Set TEMPLATE_CATALOG_PATH or commit constants/templateCatalog/template-catalog.json. Tried: ${candidates.join(", ")}`
  );
}

let _cached = null;

function loadCatalog() {
  if (_cached) return _cached;
  const raw = fs.readFileSync(resolveCatalogPath(), "utf8");
  _cached = JSON.parse(raw);
  return _cached;
}

function getCatalogGroups() {
  return loadCatalog().groups || [];
}

function getAllSlots() {
  return getCatalogGroups().flatMap((g) => g.slots || []);
}

function getSlotById(slotId) {
  return getAllSlots().find((s) => s.id === slotId) || null;
}

function getSlotByMetaName(metaName) {
  const canon = resolveCanonicalTemplateName(metaName);
  const n = String(metaName || "").toLowerCase();
  const c = String(canon || "").toLowerCase();
  return (
    getAllSlots().find((slot) => {
      const names = (slot.metaNames || []).map((x) => String(x).toLowerCase());
      return (
        String(slot.canonicalMetaName || "").toLowerCase() === c ||
        names.includes(n) ||
        names.includes(c)
      );
    }) || null
  );
}

function getFeatureReadinessDefinitions() {
  return loadCatalog().featureReadiness || [];
}

function getNameAliases() {
  return loadCatalog().nameAliases || {};
}

function getPrebuiltRequiredMetaNames() {
  return loadCatalog().prebuiltRequiredMetaNames || [];
}

function getFeatureAutomations() {
  return loadCatalog().featureAutomations || [];
}

function getEcoStandardNames() {
  return loadCatalog().ecoStandardNames || [];
}

function getCatalogVersion() {
  return loadCatalog().version || 1;
}

/** Resolve legacy / alias names to canonical Meta template name. */
function resolveCanonicalTemplateName(name) {
  const n = String(name || "").trim();
  if (!n) return n;
  const aliases = getNameAliases();
  let current = n;
  const seen = new Set();
  while (aliases[current] && !seen.has(current)) {
    seen.add(current);
    current = aliases[current];
  }
  return current;
}

/** All lookup names for a slot (metaNames + aliases that point to any of them). */
function expandSlotLookupNames(slot) {
  const base = new Set((slot?.metaNames || []).map((x) => String(x)));
  if (slot?.canonicalMetaName) base.add(String(slot.canonicalMetaName));
  const aliases = getNameAliases();
  for (const [alias, target] of Object.entries(aliases)) {
    if (base.has(target)) base.add(alias);
    for (const n of [...base]) {
      if (aliases[n] && base.has(aliases[n])) base.add(n);
    }
  }
  return [...base];
}

function validateEcoStandardPack(standardTemplates) {
  const ecoNames = new Set(getEcoStandardNames());
  const packNames = (standardTemplates || []).map((t) => t.name);
  const missing = packNames.filter((n) => !ecoNames.has(n));
  const extra = [...ecoNames].filter((n) => !packNames.includes(n));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra, packNames };
}

module.exports = {
  loadCatalog,
  getCatalogGroups,
  getAllSlots,
  getSlotById,
  getSlotByMetaName,
  getFeatureReadinessDefinitions,
  getNameAliases,
  getPrebuiltRequiredMetaNames,
  getFeatureAutomations,
  getEcoStandardNames,
  getCatalogVersion,
  resolveCanonicalTemplateName,
  expandSlotLookupNames,
  validateEcoStandardPack,
};
