"use strict";

/**
 * Maps the Commerce Flow Wizard "universal" payload (onboardingData.features shape)
 * into the flat `wizardFeatures` + top-level wizard fields consumed by
 * `utils/flowGenerator.js` and `utils/wizardMapper.js`.
 *
 * Designed for multi-tenant SaaS: each client carries their own toggles;
 * nothing is hardcoded to a single vertical.
 */

function bool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "false") return v === "true";
  return fallback;
}

/**
 * Dashboard + legacy wizard send flat `wizardFeatures` keys (`enableCatalog`, …).
 * Newer payloads nest under `browseProducts`, `abandonedCart`, etc.
 */
function isLegacyFlatWizardFeatures(u) {
  if (!u || typeof u !== "object") return false;
  if (
    u.browseProducts ||
    u.orderTracking ||
    u.cancelOrder ||
    u.helpWithOrder ||
    u.warranty ||
    u.loyalty ||
    u.aiHelpDesk ||
    u.talkToAgent ||
    u.abandonedCart ||
    u.codConfirmation
  ) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(u, "enableCatalog") ||
    Object.prototype.hasOwnProperty.call(u, "enableOrderTracking") ||
    Object.prototype.hasOwnProperty.call(u, "enableLoyalty")
  );
}

/**
 * Nested universal object → flat flags (defaults when nested keys absent).
 */
function nestedUniversalToWizardFeatures(universal = {}) {
  const u = universal || {};
  const browse = u.browseProducts || {};
  const cancel = u.cancelOrder || {};
  const help = u.helpWithOrder || {};
  const warranty = u.warranty || {};
  const loyalty = u.loyalty || {};
  const aiDesk = u.aiHelpDesk || {};
  const agent = u.talkToAgent || {};
  const cart = u.abandonedCart || {};
  const cod = u.codConfirmation || {};
  const timing = Array.isArray(cart.timing) ? cart.timing.map((n) => Number(n) || 0) : [];
  const reminders = Math.min(3, Math.max(1, Number(cart.reminders) || 2));

  return {
    enableCatalog: bool(browse.enabled, true),
    enableOrderTracking: bool(u.orderTracking?.enabled, true),
    enableReturnsRefunds: bool(help.enabled, false),
    enableCancelOrder: bool(cancel.enabled, true),
    cancelRequireReason: cancel.requireReason !== false,
    cancelAllowModify: cancel.allowModify !== false,
    enableWarranty: bool(warranty.enabled, false),
    warrantyGeneratePdf: warranty.generatePDF !== false,
    warrantyDuration: warranty.defaultPeriod
      ? `${warranty.defaultPeriod} ${warranty.defaultUnit || "months"}`
      : undefined,
    enableInstallSupport: bool(help.enabled, bool(help.hasInstallSupport, false)),
    helpIncludeInstallGuide: help.hasInstallSupport !== false,
    installSupportPrompt:
      help.installProductType
        ? `Need setup help for ${help.installProductType}? Share your product name and a photo — our team guides you step by step.`
        : undefined,
    enableLoyalty: bool(loyalty.enabled, false),
    loyaltySendReminders: loyalty.sendReminders !== false,
    loyaltyReminderDaysBeforeExpiry: Math.max(
      1,
      Math.min(30, Number(loyalty.reminderDaysBeforeExpiry) || 7)
    ),
    loyaltyPointsPerUnit: Math.max(1, Math.round(100 * (Number(loyalty.pointsValue) > 0 ? Number(loyalty.pointsValue) : 1))),
    enableFAQ: bool(aiDesk.enabled, false),
    enableAIFallback: bool(aiDesk.enabled, false),
    enableSupportEscalation: bool(agent.enabled !== false, true),
    enableAbandonedCart: bool(cart.enabled, false),
    cartNudgeMinutes1: timing[0] > 0 ? timing[0] : 30,
    cartNudgeHours2:
      reminders >= 2 && timing[1] > 0 ? Math.max(1, Math.round(timing[1] / 60)) : 2,
    cartNudgeHours3:
      reminders >= 3 && timing[2] > 0 ? Math.max(1, Math.round(timing[2] / 60)) : 24,
    enableOrderConfirmTpl: bool(cod.enabled, false),
    enableCodToPrepaid: bool(cod.offerPrepaidComingSoon, false),
    enableAdminAlerts: true,
    enableBusinessHoursGate: true,
    enable247: false,
    enableCatalogCheckoutRecovery: bool(browse.enabled, true),
    catalogCheckoutDelayMin: 20,
    enableMetaAdsTrigger: false,
    enableInstagramTrigger: false,
    enableB2BWholesale: false,
    enableReferral: false,
    enableReviewCollection: false,
    enableMultiLanguage: false,
    enableAutoShopifyShippedWhatsApp: true,
  };
}

/**
 * @param {object} universal - client.onboardingData.features or equivalent from wizard POST
 * @returns {object} flat feature flags for flowGenerator / Client.wizardFeatures
 */
function universalFeaturesToWizardFeatures(universal = {}) {
  const u = universal || {};
  if (isLegacyFlatWizardFeatures(u)) {
    const base = nestedUniversalToWizardFeatures({});
    const out = { ...base };
    for (const key of Object.keys(base)) {
      if (u[key] === undefined) continue;
      const bv = base[key];
      if (typeof bv === "boolean" || typeof u[key] === "boolean") {
        out[key] = bool(u[key], bv);
      } else if (typeof bv === "number") {
        const n = Number(u[key]);
        out[key] = Number.isFinite(n) ? n : bv;
      } else {
        out[key] = u[key] != null ? u[key] : bv;
      }
    }
    return out;
  }
  return nestedUniversalToWizardFeatures(u);
}

/**
 * Normalizes catalog / product mode for flowGenerator.
 * @returns {'catalog'|'text_list'|'manual'}
 */
function resolveProductMode(universal = {}, client = {}) {
  const hasMetaCatalog = !!(client.facebookCatalogId || client.metaCatalogId || client.waCatalogId);

  if (isLegacyFlatWizardFeatures(universal)) {
    if (universal.enableCatalog === false) return "manual";
    const pm = universal.productMode;
    if (pm === "text_list") return "text_list";
    if (pm === "manual") return "manual";
    if (pm === "catalog" && hasMetaCatalog) return "catalog";
    if (hasMetaCatalog) return "catalog";
    return "text_list";
  }

  const browse = universal.browseProducts || {};
  if (!browse.enabled) return "manual";
  if (browse.catalogMode === "text_list") return "text_list";
  if (browse.catalogMode === "manual") return "manual";
  if (browse.catalogMode === "catalog" && hasMetaCatalog) return "catalog";
  if (hasMetaCatalog) return "catalog";
  return "text_list";
}

/**
 * Flat wizard payload uses `cartTiming` + `features.*`; `generateCommerceWizardPack` still reads
 * nested `abandonedCart` / `codConfirmation` from `_universalFeatures`. Synthesize those keys.
 */
function buildSyntheticUniversalFeatures(body = {}, flat = {}, client = {}) {
  const ct = body.cartTiming || {};
  let reminders = 1;
  if (flat.enableAbandonedCart) {
    reminders = 3;
    if (!(Number(ct.msg2) > 0)) reminders = 1;
    else if (!(Number(ct.msg3) > 0)) reminders = 2;
  } else {
    reminders = 1;
  }

  const timing = [];
  if (flat.enableAbandonedCart) {
    timing.push(Number(ct.msg1) > 0 ? Number(ct.msg1) : Number(flat.cartNudgeMinutes1) || 30);
    if (reminders >= 2) {
      timing.push((Number(ct.msg2) > 0 ? Number(ct.msg2) : Number(flat.cartNudgeHours2) || 2) * 60);
    }
    if (reminders >= 3) {
      timing.push((Number(ct.msg3) > 0 ? Number(ct.msg3) : Number(flat.cartNudgeHours3) || 24) * 60);
    }
  }

  const codMinRaw =
    flat.codConfirmationMinutes ??
    body.codConfirmationMinutes ??
    body.codConfirmMinutes ??
    body.onboardingData?.codConfirmationMinutes;
  const codMin = Math.max(1, Math.min(180, Number(codMinRaw) || 10));

  const fakeBrowse = {
    enabled: !!flat.enableCatalog,
    catalogMode: resolveProductMode({ ...flat, productMode: body.productMode }, client),
  };

  return {
    browseProducts: fakeBrowse,
    abandonedCart: {
      enabled: !!flat.enableAbandonedCart,
      reminders,
      timing,
      includeDiscount: !!(body.cartIncludeDiscount ?? body.includeCartDiscount),
    },
    codConfirmation: {
      enabled: !!flat.enableOrderConfirmTpl,
      timingMinutes: codMin,
      offerPrepaidComingSoon: !!flat.enableCodToPrepaid,
    },
  };
}

/**
 * Merge universal wizard step payload into a `wizardData` object for generateEcommerceFlow.
 */
function buildWizardDataFromUniversal(client, body = {}) {
  const onboarding = body.onboardingData || {};
  const featuresUniversal = onboarding.features || body.features || {};
  const flat = universalFeaturesToWizardFeatures(featuresUniversal);

  const brandName =
    body.brandName ||
    onboarding.brandName ||
    onboarding.step1?.brandName ||
    client.onboardingData?.brandName ||
    client.businessName ||
    client.name ||
    "My Store";

  const supportPhone =
    body.supportPhone ||
    onboarding.step1?.supportPhone ||
    client.onboardingData?.step1?.supportPhone ||
    client.platformVars?.supportWhatsapp ||
    client.adminPhone ||
    "";

  const supportEmail =
    body.supportEmail ||
    onboarding.step1?.supportEmail ||
    client.platformVars?.supportEmail ||
    client.adminEmail ||
    "";

  const industry =
    body.industry ||
    onboarding.industry ||
    onboarding.step1?.industry ||
    client.onboardingData?.industry ||
    "";

  const websiteUrl = body.websiteUrl || onboarding.websiteUrl || onboarding.step1?.websiteUrl || "";
  const shopDomain =
    body.shopDomain ||
    client.shopDomain ||
    (websiteUrl ? String(websiteUrl).replace(/^https?:\/\//, "").split("/")[0] : "");

  const productMode =
    body.productMode ||
    (isLegacyFlatWizardFeatures(featuresUniversal) ? featuresUniversal.productMode : null) ||
    resolveProductMode(featuresUniversal, client);

  return {
    businessName: brandName,
    shopDomain,
    supportPhone,
    supportEmail,
    industry,
    websiteUrl,
    facebookCatalogId: body.facebookCatalogId || client.facebookCatalogId,
    botName: body.botName || client.ai?.persona?.name || "Assistant",
    botLanguage: body.primaryLanguage || body.botLanguage || client.ai?.persona?.language || "English",
    tone: body.brandTone || body.tone || client.ai?.persona?.tone || "friendly",
    adminPhone: body.adminWhatsapp || body.adminPhone || supportPhone,
    adminEmail: body.adminEmail || supportEmail,
    adminAlertEmail: body.adminEmail || supportEmail,
    features: flat,
    productMode,
    collections: Array.isArray(body.collections) ? body.collections : undefined,
    products: Array.isArray(body.products) ? body.products : undefined,
    useAiCopy: bool(body.useAiCopy, false),
    preserveNodeIds: body.preserveNodeIds !== false,
    _splitAutomations: bool(body.splitAutomationFlows, true),
    _universalFeatures: isLegacyFlatWizardFeatures(featuresUniversal)
      ? buildSyntheticUniversalFeatures(body, flat, client)
      : featuresUniversal,
    faqText: body.aiKnowledgeBaseText || body.knowledgeBase || "",
    knowledgeBase: body.aiKnowledgeBaseText || "",
  };
}

module.exports = {
  isLegacyFlatWizardFeatures,
  universalFeaturesToWizardFeatures,
  resolveProductMode,
  buildSyntheticUniversalFeatures,
  buildWizardDataFromUniversal,
};
