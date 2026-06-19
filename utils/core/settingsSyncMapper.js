"use strict";

const { normalizePersonaTone } = require('./personaEngine');
const {
  isKnownSlug,
  getStoreCategoryBySlug,
  resolveStoreCategorySlug,
} = require('../../constants/storeCategories');

/**
 * Mirrors Settings PATCH fields into the same canonical paths as wizardMapper.js
 * so Flow Builder, wizard re-open, AI persona, and runtime engines stay aligned.
 *
 * @param {Record<string, unknown>} updateFields - Mongo $set keys (mutated in place)
 * @param {Record<string, unknown>} body - raw PATCH body
 */
function applySettingsSyncMirrors(updateFields, body = {}) {
  if (!updateFields || typeof updateFields !== "object") return updateFields;

  if (body.facebookCatalogId !== undefined) {
    const id = String(body.facebookCatalogId || "").trim();
    updateFields.facebookCatalogId = id;
    if (id) {
      updateFields.waCatalogId = id;
      updateFields.catalogEnabled = true;
    }
  }

  if (body.googleReviewUrl !== undefined) {
    const url = String(body.googleReviewUrl || "").trim();
    updateFields.googleReviewUrl = url;
    updateFields["brand.googleReviewUrl"] = url;
    updateFields["platformVars.googleReviewUrl"] = url;
  }

  const adminDigits =
    body.adminPhone !== undefined ? String(body.adminPhone || "").trim() : null;

  if (adminDigits !== null) {
    updateFields.adminPhone = adminDigits;
    updateFields["brand.adminPhone"] = adminDigits;
    updateFields["platformVars.adminWhatsappNumber"] = adminDigits;
  }

  if (body.adminAlertWhatsapp !== undefined) {
    updateFields.adminAlertWhatsapp = String(body.adminAlertWhatsapp || "").trim();
  }

  if (body.adminEmail !== undefined) {
    updateFields.adminEmail = String(body.adminEmail || "").trim();
    updateFields["platformVars.supportEmail"] = String(body.adminEmail || "").trim();
  }

  if (body.adminAlertEmail !== undefined) {
    updateFields.adminAlertEmail = String(body.adminAlertEmail || "").trim();
  }

  if (body.businessName !== undefined) {
    const name = String(body.businessName || "").trim();
    updateFields.businessName = name;
    updateFields.name = name;
    updateFields["brand.businessName"] = name;
    updateFields["platformVars.brandName"] = name;
  }

  if (body.botName !== undefined) {
    const bot = String(body.botName || "").trim();
    updateFields["platformVars.agentName"] = bot;
    updateFields["ai.persona.name"] = bot;
    updateFields["nicheData.botName"] = bot;
  }

  if (body.supportPhone !== undefined) {
    const sup = String(body.supportPhone || "").trim();
    updateFields["platformVars.supportWhatsapp"] = sup;
    updateFields["platformVars.supportPhone"] = sup;
    updateFields.supportPhone = sup;
  }

  if (body.tone !== undefined) {
    const nt = normalizePersonaTone(body.tone) || String(body.tone || "").trim();
    if (nt) {
      updateFields["platformVars.defaultTone"] = nt;
      updateFields["ai.persona.tone"] = nt;
    }
  }

  if (body.botLanguage !== undefined) {
    const lang = String(body.botLanguage || "").trim();
    updateFields["platformVars.defaultLanguage"] = lang;
    updateFields["ai.persona.language"] = lang;
  }

  if (body.businessLogo !== undefined) {
    const logo = String(body.businessLogo || "").trim();
    updateFields.businessLogo = logo;
    updateFields["brand.businessLogo"] = logo;
    updateFields["brand.logoUrl"] = logo;
  }

  if (body.businessDescription !== undefined) {
    const desc = String(body.businessDescription || "").trim();
    updateFields["platformVars.businessDescription"] = desc;
    updateFields["ai.persona.description"] = desc;
  }

  if (body.industry !== undefined) {
    const ind = String(body.industry || "").trim();
    updateFields["onboardingData.industry"] = ind;
    updateFields["onboardingData.step1.industry"] = ind;
  }

  // Phase 2 — single canonical write path for website URL. We deliberately
  // do not write a root `Client.websiteUrl` field; the only canonical home is
  // `onboardingData.websiteUrl`. AuthContext bootstrap and the wizard pull
  // from there.
  if (body.websiteUrl !== undefined) {
    const url = String(body.websiteUrl || "").trim();
    updateFields["onboardingData.websiteUrl"] = url;
    updateFields["onboardingData.step1.websiteUrl"] = url;
  }

  // Phase 2 — accept storeCategory slug from Settings PATCH. We persist:
  //   - the slug itself
  //   - the merchant's source-of-truth marker ('user' since they edited Settings)
  //   - mirror to businessType when blank, so legacy preset code keeps working
  if (body.storeCategory !== undefined) {
    const slug = String(body.storeCategory || "").trim();
    if (isKnownSlug(slug)) {
      updateFields["onboardingData.storeCategory"] = slug;
      updateFields["onboardingData.storeCategorySource"] = "user";
      const cat = getStoreCategoryBySlug(slug);
      if (cat?.presetKey && !body.businessType) {
        updateFields["businessType"] = cat.presetKey;
      }
    } else if (!slug) {
      // Allow clearing to default
      updateFields["onboardingData.storeCategory"] = "";
      updateFields["onboardingData.storeCategorySource"] = "";
    }
  }

  if (body.categoryOverrides && typeof body.categoryOverrides === "object") {
    updateFields["onboardingData.categoryOverrides"] = {
      warranty: ["force_on", "force_off"].includes(body.categoryOverrides.warranty)
        ? body.categoryOverrides.warranty
        : null,
      install: ["force_on", "force_off"].includes(body.categoryOverrides.install)
        ? body.categoryOverrides.install
        : null,
    };
  }

  if (body.cartTiming !== undefined && typeof body.cartTiming === "object") {
    const t = body.cartTiming;
    const clamp = (v, min, max, def) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return def;
      return Math.min(max, Math.max(min, n));
    };
    updateFields["wizardFeatures.cartNudgeMinutes1"] = clamp(t.msg1, 1, 1440, 15);
    updateFields["wizardFeatures.cartNudgeHours2"] = clamp(t.msg2, 1, 168, 2);
    updateFields["wizardFeatures.cartNudgeHours3"] = clamp(t.msg3, 1, 720, 24);
    if (t.msg1_template !== undefined) {
      updateFields["wizardFeatures.cartNudgeTemplate1"] = String(t.msg1_template || "").trim();
    }
    if (t.msg2_template !== undefined) {
      updateFields["wizardFeatures.cartNudgeTemplate2"] = String(t.msg2_template || "").trim();
    }
    if (t.msg3_template !== undefined) {
      updateFields["wizardFeatures.cartNudgeTemplate3"] = String(t.msg3_template || "").trim();
    }
  }

  const policyBody = body.policies && typeof body.policies === "object" ? body.policies : body;
  const policyFields = [
    ["returnPolicy", "policies.returnPolicy", "knowledgeBase.returnPolicy"],
    ["refundPolicy", "policies.refundPolicy", null],
    ["shippingPolicy", "policies.shippingPolicy", "knowledgeBase.shippingPolicy"],
    ["privacyUrl", "policies.privacyUrl", null],
    ["termsUrl", "policies.termsUrl", null],
  ];
  for (const [key, policyPath, kbPath] of policyFields) {
    if (policyBody[key] !== undefined) {
      const val = String(policyBody[key] || "").trim();
      updateFields[policyPath] = val;
      if (kbPath) updateFields[kbPath] = val;
    }
  }
  if (body.shippingTime !== undefined) {
    const st = String(body.shippingTime || "").trim();
    updateFields["platformVars.shippingTime"] = st;
    if (!policyBody.shippingPolicy && st) {
      updateFields["policies.shippingPolicy"] = st;
    }
  }
  if (body.returnsPolicyUrl !== undefined) {
    updateFields["platformVars.returnsPolicyUrl"] = String(body.returnsPolicyUrl || "").trim();
  }
  if (body.faqUrl !== undefined) {
    updateFields["platformVars.faqUrl"] = String(body.faqUrl || "").trim();
  }

  if (body.geminiApiKey !== undefined && body.geminiApiKey !== "••••••••" && String(body.geminiApiKey).trim()) {
    const key = String(body.geminiApiKey).trim();
    updateFields.geminiApiKey = key;
    updateFields.openaiApiKey = key;
    updateFields["ai.geminiKey"] = key;
  }

  if (typeof body.isAIFallbackEnabled === "boolean") {
    updateFields.isAIFallbackEnabled = body.isAIFallbackEnabled;
    updateFields["wizardFeatures.enableAIFallback"] = body.isAIFallbackEnabled;
    updateFields["ai.fallbackEnabled"] = body.isAIFallbackEnabled;
  }

  if (body.commerceFlowPack !== undefined) {
    updateFields.commerceFlowPack = !!body.commerceFlowPack;
  }

  return updateFields;
}

/**
 * Flatten client doc for Settings UI (canonical + legacy paths).
 */
function flattenClientForSettingsUI(client = {}) {
  const pv = client.platformVars || {};
  const persona = client.ai?.persona || {};
  const wf = client.wizardFeatures || {};
  const onb = client.onboardingData || {};
  const resolvedStoreCategory = onb.storeCategory || resolveStoreCategorySlug({
    ecommerceCategories: onb.ecommerceCategories,
    aiProductCategory: onb.brandProfile?.productCategory,
    industryLabel: onb.industry || onb.step1?.industry,
  });
  return {
    businessName: pv.brandName || client.businessName || client.name || "",
    botName: pv.agentName || persona.name || client.nicheData?.botName || "",
    supportPhone: pv.supportWhatsapp || pv.supportPhone || "",
    tone: persona.tone || pv.defaultTone || "friendly",
    botLanguage: persona.language || pv.defaultLanguage || "English",
    businessLogo: client.businessLogo || client.brand?.businessLogo || client.brand?.logoUrl || "",
    businessDescription:
      pv.businessDescription || client.ai?.persona?.description || "",
    industry: client.onboardingData?.industry || client.onboardingData?.step1?.industry || "",
    // Phase 2 — single canonical website URL, plus resolved store category slug
    websiteUrl: onb.websiteUrl || onb.step1?.websiteUrl || "",
    storeCategory: resolvedStoreCategory,
    storeCategorySource: onb.storeCategorySource || (onb.storeCategory ? "ai" : "auto"),
    ecommerceCategories: Array.isArray(onb.ecommerceCategories) ? onb.ecommerceCategories : [],
    categoryOverrides: onb.categoryOverrides && typeof onb.categoryOverrides === "object"
      ? { warranty: onb.categoryOverrides.warranty || null, install: onb.categoryOverrides.install || null }
      : { warranty: null, install: null },
    cartTiming: {
      msg1: wf.cartNudgeMinutes1 ?? 15,
      msg2: wf.cartNudgeHours2 ?? 2,
      msg3: wf.cartNudgeHours3 ?? 24,
      msg1_template: wf.cartNudgeTemplate1 || "",
      msg2_template: wf.cartNudgeTemplate2 || "",
      msg3_template: wf.cartNudgeTemplate3 || "",
    },
    policies: {
      returnPolicy: client.policies?.returnPolicy || client.knowledgeBase?.returnPolicy || "",
      refundPolicy: client.policies?.refundPolicy || "",
      shippingPolicy:
        client.policies?.shippingPolicy ||
        client.knowledgeBase?.shippingPolicy ||
        pv.shippingTime ||
        "",
      privacyUrl: client.policies?.privacyUrl || "",
      termsUrl: client.policies?.termsUrl || "",
    },
    shippingTime: pv.shippingTime || "",
    returnsPolicyUrl: pv.returnsPolicyUrl || "",
    faqUrl: pv.faqUrl || "",
    facebookCatalogId: client.facebookCatalogId || client.waCatalogId || "",
    waCatalogId: client.waCatalogId || client.facebookCatalogId || "",
    googleReviewUrl: pv.googleReviewUrl || client.googleReviewUrl || client.brand?.googleReviewUrl || "",
    adminPhone: pv.adminWhatsappNumber || client.adminPhone || client.adminAlertWhatsapp || "",
    commerceFlowPack: client.commerceFlowPack !== false,
    wizardFeatures: client.wizardFeatures || {},
    platformVars: pv,
  };
}

module.exports = {
  applySettingsSyncMirrors,
  flattenClientForSettingsUI,
};
