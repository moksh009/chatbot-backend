"use strict";

/**
 * Vertical-aware defaults for multi-tenant wizard (clothing, electronics, services, etc.).
 * Merges on top of schema defaults — explicit false from user is preserved at launch.
 *
 * Phase 1.3 — `mergeWizardFeatures` now accepts a canonical `storeCategory` slug
 * (see constants/storeCategories.js). Slug → PRESETS key happens via the
 * imported SSOT; legacy regex fallback on businessType/industry is preserved
 * so existing tenants without a slug keep working.
 */

const { getStoreCategoryBySlug, isKnownSlug } = require('../../constants/storeCategories');

const ECOMMERCE_BASE = {
  enableCatalog: true,
  enableOrderTracking: false,
  enableReturnsRefunds: true,
  enableCancelOrder: true,
  enableAbandonedCart: true,
  enableCatalogCheckoutRecovery: true,
  enableOrderConfirmTpl: true,
  enableAutoShopifyShippedWhatsApp: true,
  enableFAQ: true,
  enableSupportEscalation: true,
  enableBusinessHoursGate: true,
  enableAdminAlerts: true,
  enableAIFallback: true,
  enableInstallSupport: false,
  enableWarranty: false,
  enableReferral: false,
  enableB2BWholesale: false,
};

const PRESETS = {
  ecommerce: { ...ECOMMERCE_BASE },
  fashion: {
    ...ECOMMERCE_BASE,
    enableReturnsRefunds: true,
  },
  clothing: {
    ...ECOMMERCE_BASE,
    enableReturnsRefunds: true,
  },
  electronics: {
    ...ECOMMERCE_BASE,
    enableWarranty: true,
    enableInstallSupport: true,
  },
  home: {
    ...ECOMMERCE_BASE,
    enableInstallSupport: true,
    enableWarranty: true,
  },
  beauty: {
    ...ECOMMERCE_BASE,
  },
  food: {
    ...ECOMMERCE_BASE,
    enableAbandonedCart: true,
    enableWarranty: false,
  },
  services: {
    enableCatalog: false,
    enableOrderTracking: false,
    enableReturnsRefunds: false,
    enableCancelOrder: false,
    enableAbandonedCart: false,
    enableCatalogCheckoutRecovery: false,
    enableOrderConfirmTpl: false,
    enableAutoShopifyShippedWhatsApp: false,
    enableFAQ: true,
    enableSupportEscalation: true,
    enableBusinessHoursGate: true,
    enableAdminAlerts: true,
    enableAIFallback: true,
    enableInstallSupport: true,
    enableWarranty: false,
  },
  local: {
    enableCatalog: false,
    enableOrderTracking: false,
    enableReturnsRefunds: false,
    enableCancelOrder: false,
    enableAbandonedCart: false,
    enableFAQ: true,
    enableSupportEscalation: true,
    enableAIFallback: true,
    enableWarranty: false,
  },
  "salon/spa": {
    enableCatalog: false,
    enableOrderTracking: false,
    enableFAQ: true,
    enableSupportEscalation: true,
    enableAIFallback: true,
    enableInstallSupport: true,
    enableBusinessHoursGate: true,
  },
  "clinic/doctor": {
    enableCatalog: false,
    enableFAQ: true,
    enableSupportEscalation: true,
    enableAIFallback: true,
    enableBusinessHoursGate: true,
  },
  "real estate": {
    enableCatalog: false,
    enableFAQ: true,
    enableSupportEscalation: true,
    enableAIFallback: true,
  },
  education: {
    enableCatalog: false,
    enableFAQ: true,
    enableSupportEscalation: true,
    enableAIFallback: true,
  },
  restaurant: {
    enableCatalog: false,
    enableOrderTracking: false,
    enableFAQ: true,
    enableSupportEscalation: true,
    enableAIFallback: true,
  },
};

function normalizeBusinessType(raw) {
  const t = String(raw || "ecommerce").toLowerCase().trim();
  if (PRESETS[t]) return t;
  if (/cloth|apparel|fashion|wear/.test(t)) return "fashion";
  if (/electron|tech|gadget|doorbell|light|smart home/.test(t)) return "electronics";
  if (/beauty|cosmetic|skin/.test(t)) return "beauty";
  if (/food|grocery|restaurant/.test(t)) return "food";
  if (/service|salon|clinic|support|consult/.test(t)) return "services";
  return "ecommerce";
}

function getWizardFeaturePreset(businessType, industry = "", storeCategory = "") {
  // Slug wins when known (set by signup analyze / wizard override).
  if (isKnownSlug(storeCategory)) {
    const cat = getStoreCategoryBySlug(storeCategory);
    const key = cat?.presetKey || normalizeBusinessType(businessType || industry);
    return { key, features: { ...(PRESETS[key] || PRESETS.ecommerce) }, slug: storeCategory };
  }
  const key = normalizeBusinessType(businessType || industry);
  return { key, features: { ...PRESETS[key] }, slug: null };
}

/**
 * @param {object} userFeatures   merchant-tweaked toggles (preserved unless undefined)
 * @param {string} businessType   raw biz type (legacy)
 * @param {string} industry       industry label (legacy)
 * @param {object} options
 * @param {string} [options.storeCategory] canonical slug
 * @param {object} [options.categoryOverrides] per-toggle force_on/force_off table
 */
function mergeWizardFeatures(userFeatures = {}, businessType = "", industry = "", options = {}) {
  const { storeCategory = "", categoryOverrides = {} } = options || {};
  const { features: preset } = getWizardFeaturePreset(businessType, industry, storeCategory);
  const out = { ...preset };

  // Apply merchant overrides last so explicit values win over preset.
  for (const [k, v] of Object.entries(userFeatures || {})) {
    if (typeof v === "boolean") out[k] = v;
    else if (v !== undefined && v !== null) out[k] = v;
  }

  // Category overrides ("force_on" / "force_off") always win — they represent an
  // explicit merchant choice persisted to onboardingData.storeProfile.categoryOverrides.
  if (categoryOverrides && typeof categoryOverrides === "object") {
    if (categoryOverrides.warranty === "force_on")  out.enableWarranty = true;
    if (categoryOverrides.warranty === "force_off") out.enableWarranty = false;
    if (categoryOverrides.install === "force_on")  out.enableInstallSupport = true;
    if (categoryOverrides.install === "force_off") out.enableInstallSupport = false;
  }

  return out;
}

module.exports = {
  PRESETS,
  normalizeBusinessType,
  getWizardFeaturePreset,
  mergeWizardFeatures,
};
