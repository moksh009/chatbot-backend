"use strict";

const { normalizePersonaTone } = require("./personaEngine");

/**
 * WIZARD MAPPER — Onboarding Wizard payload → Mongo $set / $push contract.
 * Adding a wizard field?  → add ONE line here, nowhere else.
 *
 * Design rules:
 *   1. Never leak `undefined` into Mongo. `setIfDefined` filters those out so
 *      half-filled wizards don't blank existing values via `$set: { foo: undefined }`.
 *   2. Mirror canonical fields into both new (`platformVars.*`, `ai.persona.*`,
 *      `wizardFeatures.*`) AND legacy locations the dual-brain engine still
 *      reads (e.g. `geminiApiKey`, `businessName`, `loyaltyConfig.enabled`).
 *      These mirrors get removed once Phase 24 migration is finished.
 *   3. wizardFeatures booleans accept `undefined` → defaults; explicit `false`
 *      is honored (used by Settings to turn things off).
 *
 * @see  models/Client.js  (WizardFeaturesSchema, AiPersonaSchema)
 * @see  routes/wizard.js  (POST /:clientId/complete)
 * @see  utils/flowGenerator.js  (consumes the same field names)
 */

// ────────────────────────────────────────────────────────────────────────────
// Tiny utilities
// ────────────────────────────────────────────────────────────────────────────
function setIfDefined(target, key, value) {
  if (value !== undefined && value !== null) target[key] = value;
}

function setIfTruthy(target, key, value) {
  if (value) target[key] = value;
}

function setBool(target, key, value) {
  if (typeof value === "boolean") target[key] = value;
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// ────────────────────────────────────────────────────────────────────────────
// Feature toggle reader. Accepts `wizardData.features` (new shape) OR top-level
// legacy fields (e.g. `wizardData.b2bEnabled`, `wizardData.is247`) so older
// wizard versions and Settings PATCH calls all work.
// ────────────────────────────────────────────────────────────────────────────
function buildFeaturesUpdate(wizardData = {}) {
  const f = wizardData.features || {};
  const out = {};

  // Core commerce
  setBool(out, "wizardFeatures.enableCatalog",         f.enableCatalog);
  setBool(out, "wizardFeatures.enableOrderTracking",   f.enableOrderTracking);
  setBool(out, "wizardFeatures.enableReturnsRefunds",  f.enableReturnsRefunds);
  setBool(out, "wizardFeatures.enableCancelOrder",     f.enableCancelOrder);
  setBool(out, "wizardFeatures.enableCodToPrepaid",
    typeof f.enableCodToPrepaid === "boolean"
      ? f.enableCodToPrepaid
      : (wizardData.razorpayKeyId || wizardData.cashfreeAppId ? true : undefined));
  if (f.codDiscountAmount !== undefined || wizardData.codDiscount !== undefined) {
    out["wizardFeatures.codDiscountAmount"] = clampNum(
      f.codDiscountAmount ?? wizardData.codDiscount, 0, 5000, 50);
  }
  setBool(out, "wizardFeatures.enableAbandonedCart", f.enableAbandonedCart);
  setBool(out, "wizardFeatures.enableCatalogCheckoutRecovery", f.enableCatalogCheckoutRecovery);
  if (f.catalogCheckoutDelayMin !== undefined) {
    out["wizardFeatures.catalogCheckoutDelayMin"] = clampNum(f.catalogCheckoutDelayMin, 1, 180, 20);
  }
  if (wizardData.cartTiming || f.cartNudgeMinutes1 !== undefined) {
    const t = wizardData.cartTiming || {};
    out["wizardFeatures.cartNudgeMinutes1"] = clampNum(f.cartNudgeMinutes1 ?? t.msg1, 1, 1440, 15);
    out["wizardFeatures.cartNudgeHours2"]   = clampNum(f.cartNudgeHours2   ?? t.msg2, 1, 168, 2);
    out["wizardFeatures.cartNudgeHours3"]   = clampNum(f.cartNudgeHours3   ?? t.msg3, 1, 720, 24);
  }

  // Loyalty & growth
  setBool(out, "wizardFeatures.enableLoyalty",
    typeof f.enableLoyalty === "boolean"
      ? f.enableLoyalty
      : (wizardData.signupPoints || wizardData.referralPoints ? true : undefined));
  if (f.loyaltyPointsPerUnit !== undefined) {
    out["wizardFeatures.loyaltyPointsPerUnit"] = clampNum(f.loyaltyPointsPerUnit, 1, 1000, 10);
  }
  if (wizardData.signupPoints !== undefined || f.loyaltySignupBonus !== undefined) {
    out["wizardFeatures.loyaltySignupBonus"] = clampNum(
      f.loyaltySignupBonus ?? wizardData.signupPoints, 0, 100000, 100);
  }
  if (f.loyaltySilverThreshold !== undefined) {
    out["wizardFeatures.loyaltySilverThreshold"] = clampNum(f.loyaltySilverThreshold, 0, 1000000, 500);
  }
  if (f.loyaltyGoldThreshold !== undefined) {
    out["wizardFeatures.loyaltyGoldThreshold"] = clampNum(f.loyaltyGoldThreshold, 0, 1000000, 1500);
  }
  setBool(out, "wizardFeatures.enableReferral", f.enableReferral);
  if (wizardData.referralPoints !== undefined || f.referralPointsBonus !== undefined) {
    out["wizardFeatures.referralPointsBonus"] = clampNum(
      f.referralPointsBonus ?? wizardData.referralPoints, 0, 100000, 500);
  }
  setBool(out, "wizardFeatures.enableReviewCollection",
    typeof f.enableReviewCollection === "boolean"
      ? f.enableReviewCollection
      : (wizardData.googleReviewUrl ? true : undefined));
  if (f.reviewDelayDays !== undefined) {
    out["wizardFeatures.reviewDelayDays"] = clampNum(f.reviewDelayDays, 1, 60, 4);
  }

  // Service & post-purchase
  setBool(out, "wizardFeatures.enableWarranty",
    typeof f.enableWarranty === "boolean"
      ? f.enableWarranty
      : (wizardData.warrantyDuration ? true : undefined));
  setIfTruthy(out, "wizardFeatures.warrantyDuration",
    f.warrantyDuration || wizardData.warrantyDuration);
  setIfTruthy(out, "wizardFeatures.warrantySupportPhone",
    f.warrantySupportPhone || wizardData.warrantySupportPhone);
  setIfTruthy(out, "wizardFeatures.warrantySupportEmail",
    f.warrantySupportEmail || wizardData.warrantySupportEmail || wizardData.supportEmail);
  setIfTruthy(out, "wizardFeatures.warrantyClaimUrl",
    f.warrantyClaimUrl || wizardData.warrantyClaimUrl);
  setBool(out, "wizardFeatures.enableInstallSupport", f.enableInstallSupport);
  setIfTruthy(out, "wizardFeatures.installSupportPrompt",
    f.installSupportPrompt || wizardData.installSupportPrompt);
  setBool(out, "wizardFeatures.enableFAQ", f.enableFAQ);
  setBool(out, "wizardFeatures.enableSupportEscalation", f.enableSupportEscalation);
  if (f.humanEscalationTimeoutMin !== undefined) {
    out["wizardFeatures.humanEscalationTimeoutMin"] =
      clampNum(f.humanEscalationTimeoutMin, 1, 1440, 30);
  }
  setBool(out, "wizardFeatures.enableBusinessHoursGate", f.enableBusinessHoursGate);
  setBool(out, "wizardFeatures.enable247",
    typeof f.enable247 === "boolean" ? f.enable247 : wizardData.is247);

  // Channels & growth
  setBool(out, "wizardFeatures.enableInstagramTrigger", f.enableInstagramTrigger);
  setBool(out, "wizardFeatures.enableMetaAdsTrigger",
    typeof f.enableMetaAdsTrigger === "boolean"
      ? f.enableMetaAdsTrigger
      : (wizardData.metaAdsToken ? true : undefined));
  setBool(out, "wizardFeatures.enableB2BWholesale",
    typeof f.enableB2BWholesale === "boolean"
      ? f.enableB2BWholesale
      : wizardData.b2bEnabled);

  // AI behavior
  setBool(out, "wizardFeatures.enableAIFallback", f.enableAIFallback);
  setBool(out, "wizardFeatures.enableMultiLanguage", f.enableMultiLanguage);

  // Notifications
  setBool(out, "wizardFeatures.enableAdminAlerts", f.enableAdminAlerts);
  setBool(out, "wizardFeatures.enableOrderConfirmTpl", f.enableOrderConfirmTpl);
  setBool(out, "wizardFeatures.enableAutoShopifyShippedWhatsApp", f.enableAutoShopifyShippedWhatsApp);

  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Brand / business identity → platformVars + legacy mirrors.
// ────────────────────────────────────────────────────────────────────────────
function buildBrandUpdate(wizardData = {}, client = {}) {
  const out = {};
  const checkoutFallback = client.shopDomain ? `https://${client.shopDomain}/checkout` : "";

  if (wizardData.businessName) {
    out["platformVars.brandName"]    = wizardData.businessName;
    out["brand.businessName"]        = wizardData.businessName;
    out.businessName                 = wizardData.businessName; // legacy required field
    out.name                         = wizardData.businessName; // legacy alias
  }
  if (wizardData.shopDomain) {
    const host = String(wizardData.shopDomain).replace(/^https?:\/\//, "");
    out.shopDomain = host;
    out["platformVars.storeUrl"] = `https://${host}`;
  }
  setIfTruthy(out, "facebookCatalogId", wizardData.facebookCatalogId);
  setIfTruthy(out, "metaCatalogAccessToken", wizardData.metaCatalogAccessToken);
  setIfTruthy(out, "shopifyStorefrontToken", wizardData.shopifyStorefrontToken);
  setIfTruthy(out, "platformVars.agentName", wizardData.botName);
  if (wizardData.botName) out["nicheData.botName"] = wizardData.botName;

  setIfTruthy(out, "platformVars.supportWhatsapp", wizardData.supportPhone);
  if (wizardData.supportPhone) {
    out["platformVars.supportPhone"] = wizardData.supportPhone;
  }
  setIfTruthy(out, "onboardingData.industry", wizardData.industry);
  setIfTruthy(out, "onboardingData.step1.industry", wizardData.industry);

  setIfTruthy(out, "platformVars.adminWhatsappNumber", wizardData.adminPhone);
  setIfTruthy(out, "adminPhone",                       wizardData.adminPhone);
  setIfTruthy(out, "adminAlertWhatsapp",               wizardData.adminPhone);

  setIfTruthy(out, "adminAlertEmail", wizardData.adminAlertEmail);
  if (wizardData.adminEmail && String(wizardData.adminEmail).trim()) {
    const em = String(wizardData.adminEmail).trim();
    out.adminEmail = em;
    if (!out.adminAlertEmail) out.adminAlertEmail = em;
  }
  if (wizardData.adminAlertPreferences === "whatsapp" || wizardData.adminAlertPreferences === "email" || wizardData.adminAlertPreferences === "both") {
    out.adminAlertPreferences = wizardData.adminAlertPreferences;
  }
  setIfTruthy(out, "platformVars.baseCurrency",        wizardData.currency || "₹");
  setIfTruthy(out, "brand.currency",                   wizardData.currency || "₹");
  setIfTruthy(out, "platformVars.businessDescription", wizardData.businessDescription);
  setIfTruthy(out, "platformVars.shippingTime",        wizardData.shippingTime);
  setIfTruthy(out, "platformVars.checkoutUrl",         wizardData.checkoutUrl || checkoutFallback || undefined);
  setIfTruthy(out, "platformVars.googleReviewUrl",     wizardData.googleReviewUrl);
  setIfTruthy(out, "googleReviewUrl",                  wizardData.googleReviewUrl);
  setIfTruthy(out, "brand.googleReviewUrl",            wizardData.googleReviewUrl);
  setIfTruthy(out, "platformVars.supportEmail",        wizardData.supportEmail);
  setIfTruthy(out, "platformVars.openTime",            wizardData.openTime);
  setIfTruthy(out, "platformVars.closeTime",           wizardData.closeTime);
  setIfTruthy(out, "platformVars.warrantyDuration",    wizardData.warrantyDuration);
  if (wizardData.tone) {
    const nt = normalizePersonaTone(wizardData.tone) || wizardData.tone;
    setIfTruthy(out, "platformVars.defaultTone", nt);
  }
  setIfTruthy(out, "platformVars.defaultLanguage",     wizardData.botLanguage);

  // Brand sub-doc (used by templates + warranty engine)
  setIfTruthy(out, "brand.warrantyDuration",        wizardData.warrantyDuration);
  setIfTruthy(out, "brand.warrantyPolicy",          wizardData.warrantyPolicy);
  setIfTruthy(out, "brand.warrantySupportPhone",    wizardData.warrantySupportPhone);
  setIfTruthy(out, "brand.warrantyClaimUrl",        wizardData.warrantyClaimUrl);
  setIfDefined(out, "brand.warrantyEmailEnabled",   wizardData.warrantyEmailEnabled);
  setIfDefined(out, "brand.warrantyWhatsappEnabled", wizardData.warrantyWhatsappEnabled);
  setIfTruthy(out, "brand.businessLogo",            wizardData.businessLogo);
  setIfTruthy(out, "brand.logoUrl",                 wizardData.businessLogo);
  setIfTruthy(out, "businessLogo",                  wizardData.businessLogo);
  setIfTruthy(out, "brand.authorizedSignature",     wizardData.authorizedSignature);
  setIfTruthy(out, "authorizedSignature",           wizardData.authorizedSignature);

  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// AI persona / system prompt / API keys → ai.* (canonical) + legacy mirrors.
// ────────────────────────────────────────────────────────────────────────────
function buildAiUpdate(wizardData = {}, generatedSystemPrompt = "") {
  const out = {};

  // Persona (Phase 29)
  if (wizardData.botName)             out["ai.persona.name"]        = wizardData.botName;
  if (wizardData.tone) {
    const nt = normalizePersonaTone(wizardData.tone) || wizardData.tone;
    out["ai.persona.tone"] = nt;
  }
  if (wizardData.botLanguage)         out["ai.persona.language"]    = wizardData.botLanguage;
  if (wizardData.businessDescription) out["ai.persona.description"] = wizardData.businessDescription;
  if (wizardData.activePersona) {
    out["ai.persona.role"] = wizardData.activePersona;
    out["ai.enterprisePersona"] = wizardData.activePersona;
  }
  if (wizardData.emojiLevel)          out["ai.persona.emojiLevel"]  = wizardData.emojiLevel;
  if (wizardData.formality)           out["ai.persona.formality"]   = wizardData.formality;
  setBool(out, "ai.persona.autoTranslate", wizardData.autoTranslate);
  if (Array.isArray(wizardData.signaturePhrases)) out["ai.persona.signaturePhrases"] = wizardData.signaturePhrases;
  if (Array.isArray(wizardData.avoidTopics))      out["ai.persona.avoidTopics"]      = wizardData.avoidTopics;

  // Knowledge base (FAQs / policies sent into prompts)
  setIfTruthy(out, "ai.persona.knowledgeBase", wizardData.knowledgeBase || wizardData.faqText);

  // System prompt — canonical at ai.systemPrompt; legacy mirror at top-level.
  if (generatedSystemPrompt) {
    out["ai.systemPrompt"] = generatedSystemPrompt;
    out.systemPrompt       = generatedSystemPrompt;
  }

  // Gemini key — canonical at ai.geminiKey; legacy mirrors for older code paths.
  if (wizardData.geminiApiKey) {
    out["ai.geminiKey"] = wizardData.geminiApiKey;
    out.geminiApiKey    = wizardData.geminiApiKey;
    out.openaiApiKey    = wizardData.geminiApiKey;
  }

  setBool(out, "ai.fallbackEnabled", wizardData.enableAIFallback);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Policies (return / refund / shipping / warranty narrative text).
// ────────────────────────────────────────────────────────────────────────────
function buildPoliciesUpdate(wizardData = {}) {
  const out = {};
  setIfTruthy(out, "policies.returnPolicy",   wizardData.returnPolicy   || wizardData.returnsInfo);
  setIfTruthy(out, "policies.refundPolicy",   wizardData.refundPolicy);
  setIfTruthy(out, "policies.shippingPolicy", wizardData.shippingPolicy || wizardData.shippingTime);
  setIfTruthy(out, "policies.warrantyPolicy", wizardData.warrantyPolicy);
  setIfTruthy(out, "policies.privacyUrl",     wizardData.privacyUrl);
  setIfTruthy(out, "policies.termsUrl",       wizardData.termsUrl);
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Legacy loyalty / warranty / payment integration mirrors. These are still
// read by older engines (loyaltyEngine, warrantyEngine, payment workers) so
// keeping them in sync prevents regressions while we migrate to wizardFeatures.
// ────────────────────────────────────────────────────────────────────────────
function buildLegacyMirrors(wizardData = {}) {
  const out = {};

  if (wizardData.referralPoints !== undefined) {
    out["brand.referralPoints"]              = wizardData.referralPoints;
    out["loyaltyConfig.referralBonus"]       = wizardData.referralPoints;
    out["loyaltyConfig.pointsPerUnit"]       = wizardData.referralPoints;
    out["loyaltyConfig.enabled"]             = true;
  }
  if (wizardData.signupPoints !== undefined) {
    out["brand.signupPoints"]                = wizardData.signupPoints;
    out["loyaltyConfig.welcomeBonus"]        = wizardData.signupPoints;
  }
  if (wizardData.features?.loyaltySilverThreshold !== undefined) {
    out["loyaltyConfig.tierThresholds.silver"] = wizardData.features.loyaltySilverThreshold;
  }
  if (wizardData.features?.loyaltyGoldThreshold !== undefined) {
    out["loyaltyConfig.tierThresholds.gold"] = wizardData.features.loyaltyGoldThreshold;
  }

  if (wizardData.is247 !== undefined)        out["config.businessHours.is247"]    = wizardData.is247;
  setIfTruthy(out, "config.businessHours.openTime",    wizardData.openTime);
  setIfTruthy(out, "config.businessHours.closeTime",   wizardData.closeTime);
  if (wizardData.workingDays)                out["config.businessHours.workingDays"] = wizardData.workingDays;

  if (wizardData.b2bEnabled !== undefined) {
    out["brand.b2bEnabled"]   = wizardData.b2bEnabled;
    out["config.b2bEnabled"]  = wizardData.b2bEnabled;
  }
  setIfTruthy(out, "brand.b2bThreshold",   wizardData.b2bThreshold);
  setIfTruthy(out, "brand.b2bAdminPhone",  wizardData.b2bAdminPhone);

  setIfTruthy(out, "config.shippingTime", wizardData.shippingTime);
  setIfTruthy(out, "config.productMode",  wizardData.productMode);

  if (wizardData.warrantySupportPhone) out["warrantyConfig.supportPhone"] = wizardData.warrantySupportPhone;
  if (wizardData.warrantyClaimUrl)     out["warrantyConfig.claimUrl"]     = wizardData.warrantyClaimUrl;
  setIfDefined(out, "warrantyConfig.emailEnabled",    wizardData.warrantyEmailEnabled);
  setIfDefined(out, "warrantyConfig.whatsappEnabled", wizardData.warrantyWhatsappEnabled);
  setIfDefined(out, "warrantyConfig.autoAssign",      wizardData.autoAssignWarranty);

  if (wizardData.metaAdsToken) {
    out.metaAdsConnected            = true;
    out.metaAdAccountId             = wizardData.metaAdAccountId;
    out.metaAdsToken                = wizardData.metaAdsToken;
    out["social.metaAds.accountId"] = wizardData.metaAdAccountId;
    out["social.metaAds.accessToken"] = wizardData.metaAdsToken;
  }
  setIfTruthy(out, "metaAppId", wizardData.metaAppId);

  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Build the legacy `automationFlows[]` array. Now driven by wizardFeatures
// instead of just inferring from raw fields, so toggling a feature in
// Settings actually flips the automation on/off.
// ────────────────────────────────────────────────────────────────────────────
function buildAutomationFlows(featuresUpdate, wizardData = {}) {
  const get = (k, fallback) =>
    featuresUpdate[`wizardFeatures.${k}`] !== undefined
      ? featuresUpdate[`wizardFeatures.${k}`]
      : fallback;

  const enableCart    = get("enableAbandonedCart", true);
  const enableCod     = get("enableCodToPrepaid", false);
  const enableReview  = get("enableReviewCollection", false);
  const m1 = get("cartNudgeMinutes1", 15);
  const h2 = get("cartNudgeHours2", 2);
  const h3 = get("cartNudgeHours3", 24);
  const codDiscount   = get("codDiscountAmount", 50);
  const reviewDelay   = get("reviewDelayDays", 4);

  const flows = [];

  if (enableCart) {
    flows.push({
      id: "abandoned_cart",
      type: "abandoned_cart",
      name: "Abandoned Cart Recovery",
      isActive: true,
      config: {
        nudge1_offset_ms: m1 * 60 * 1000,
        nudge2_offset_ms: h2 * 60 * 60 * 1000,
        nudge3_offset_ms: h3 * 60 * 60 * 1000,
        timing_mode: "absolute"
      }
    });
  }

  if (enableCod) {
    flows.push({
      id: "cod_to_prepaid",
      type: "cod_to_prepaid",
      name: "COD → Prepaid Conversion",
      isActive: true,
      config: {
        delayMinutes:    3,
        discountAmount:  codDiscount,
        razorpayEnabled: !!wizardData.razorpayKeyId,
        cashfreeEnabled: !!wizardData.cashfreeAppId
      }
    });
  }

  if (enableReview) {
    flows.push({
      id: "review_collection",
      type: "review_collection",
      name: "Post-Delivery Review Collection",
      isActive: true,
      config: {
        delayDays:    reviewDelay,
        reviewUrl:    wizardData.googleReviewUrl || ""
      }
    });
  }

  return flows;
}

// ────────────────────────────────────────────────────────────────────────────
// PUBLIC API
//   mapWizardToClient(wizardData, client, { systemPrompt }) → { $set, $push? }
//   mapFeatureToggle(features) → $set patch (used by Settings)
// ────────────────────────────────────────────────────────────────────────────
function mapWizardToClient(wizardData = {}, client = {}, opts = {}) {
  const { systemPrompt = "" } = opts;

  const featuresUpdate = buildFeaturesUpdate(wizardData);
  const $set = {
    wizardCompleted:    true,
    wizardCompletedAt:  new Date(),
    isAIFallbackEnabled: featuresUpdate["wizardFeatures.enableAIFallback"] !== false,
    ...(typeof wizardData.commerceFlowPack === "boolean"
      ? { commerceFlowPack: wizardData.commerceFlowPack }
      : {}),
    ...buildBrandUpdate(wizardData, client),
    ...buildAiUpdate(wizardData, systemPrompt),
    ...buildPoliciesUpdate(wizardData),
    ...buildLegacyMirrors(wizardData),
    ...featuresUpdate,
  };

  const automationFlows = buildAutomationFlows(featuresUpdate, wizardData);
  if (automationFlows.length > 0) $set.automationFlows = automationFlows;

  if (wizardData.faqText) {
    $set.faq = [{ question: "About Us / General", answer: wizardData.faqText, order: 1 }];
  }

  // Strip undefined entries defensively (belt & braces).
  for (const key of Object.keys($set)) {
    if ($set[key] === undefined) delete $set[key];
  }

  const result = { $set };

  if (Array.isArray(wizardData.products) && wizardData.products.length > 0) {
    $set["nicheData.products"] = wizardData.products.map((p) => ({
      id: p.id || p.shopifyId || p.handle,
      name: p.name || p.title,
      title: p.title || p.name,
      price: p.price,
      imageUrl: p.imageUrl || (Array.isArray(p.images) && p.images[0]?.src) || "",
      handle: p.handle || String(p.title || p.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      description: p.description || "",
      category: p.category || "General"
    }));
  }

  // Custom Meta templates pushed by the wizard (handled separately by route)
  if (Array.isArray(wizardData.customTemplates) && wizardData.customTemplates.length > 0) {
    result.$push = {
      messageTemplates: {
        $each: wizardData.customTemplates.map(t => ({
          ...t, status: "PENDING", source: "wizard_custom", createdAt: new Date()
        }))
      }
    };
  }

  return result;
}

function pullPersonaBundleFromSet($set) {
  const persona = {};
  const removeKeys = [];
  for (const key of Object.keys($set)) {
    if (key.startsWith("ai.persona.")) {
      persona[key.slice("ai.persona.".length)] = $set[key];
      removeKeys.push(key);
    }
  }
  for (const k of removeKeys) delete $set[k];
  let systemPrompt;
  if ($set["ai.systemPrompt"] !== undefined) {
    systemPrompt = $set["ai.systemPrompt"];
    delete $set["ai.systemPrompt"];
  }
  if ($set.systemPrompt !== undefined) {
    systemPrompt = systemPrompt ?? $set.systemPrompt;
    delete $set.systemPrompt;
  }
  return { persona, systemPrompt };
}

function mapFeatureToggle(features = {}) {
  const $set = buildFeaturesUpdate({ features });
  // Mirror legacy where it matters
  if (typeof features.enable247 === "boolean")        $set["config.businessHours.is247"]      = features.enable247;
  if (typeof features.enableLoyalty === "boolean")    $set["loyaltyConfig.enabled"]           = features.enableLoyalty;
  if (features.loyaltyPointsPerUnit !== undefined)    $set["loyaltyConfig.pointsPerUnit"]      = clampNum(features.loyaltyPointsPerUnit, 1, 100000, 10);
  if (features.loyaltySignupBonus !== undefined)      $set["loyaltyConfig.welcomeBonus"]       = clampNum(features.loyaltySignupBonus, 0, 1000000, 100);
  if (features.loyaltySilverThreshold !== undefined)  $set["loyaltyConfig.tierThresholds.silver"] = clampNum(features.loyaltySilverThreshold, 0, 1000000, 500);
  if (features.loyaltyGoldThreshold !== undefined)    $set["loyaltyConfig.tierThresholds.gold"] = clampNum(features.loyaltyGoldThreshold, 0, 1000000, 1500);
  if (typeof features.enableB2BWholesale === "boolean") {
    $set["brand.b2bEnabled"]  = features.enableB2BWholesale;
    $set["config.b2bEnabled"] = features.enableB2BWholesale;
  }
  if (features.warrantyDuration)         $set["brand.warrantyDefaultDuration"] = features.warrantyDuration;
  if (features.warrantySupportPhone)     $set["brand.warrantySupportPhone"]     = features.warrantySupportPhone;
  if (features.warrantySupportEmail)     $set["platformVars.supportEmail"]       = features.warrantySupportEmail;
  if (features.warrantyClaimUrl)         $set["brand.warrantyClaimUrl"]          = features.warrantyClaimUrl;
  return $set;
}

module.exports = {
  mapWizardToClient,
  mapFeatureToggle,
  buildFeaturesUpdate,
  buildAutomationFlows,
  pullPersonaBundleFromSet,
};
