"use strict";

/**
 * Vertical-aware defaults for multi-tenant wizard (clothing, electronics, services, etc.).
 * Merges on top of schema defaults — explicit false from user is preserved at launch.
 */

const ECOMMERCE_BASE = {
  enableCatalog: true,
  enableOrderTracking: true,
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
  enableLoyalty: false,
  enableReferral: false,
  enableReviewCollection: false,
  enableB2BWholesale: false,
};

const PRESETS = {
  ecommerce: { ...ECOMMERCE_BASE },
  fashion: {
    ...ECOMMERCE_BASE,
    enableReturnsRefunds: true,
    enableReviewCollection: true,
    enableLoyalty: true,
  },
  clothing: {
    ...ECOMMERCE_BASE,
    enableReturnsRefunds: true,
    enableReviewCollection: true,
    enableLoyalty: true,
  },
  electronics: {
    ...ECOMMERCE_BASE,
    enableWarranty: true,
    enableInstallSupport: true,
    enableReviewCollection: true,
  },
  home: {
    ...ECOMMERCE_BASE,
    enableInstallSupport: true,
    enableWarranty: true,
  },
  beauty: {
    ...ECOMMERCE_BASE,
    enableLoyalty: true,
    enableReviewCollection: true,
  },
  food: {
    ...ECOMMERCE_BASE,
    enableAbandonedCart: true,
    enableWarranty: false,
    enableLoyalty: true,
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
    enableLoyalty: false,
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
    enableLoyalty: false,
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
    enableOrderTracking: true,
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

function getWizardFeaturePreset(businessType, industry = "") {
  const key = normalizeBusinessType(businessType || industry);
  return { key, features: { ...PRESETS[key] } };
}

function mergeWizardFeatures(userFeatures = {}, businessType = "", industry = "") {
  const { features: preset } = getWizardFeaturePreset(businessType, industry);
  const out = { ...preset };
  for (const [k, v] of Object.entries(userFeatures || {})) {
    if (typeof v === "boolean") out[k] = v;
    else if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

module.exports = {
  PRESETS,
  normalizeBusinessType,
  getWizardFeaturePreset,
  mergeWizardFeatures,
};
