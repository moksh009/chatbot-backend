"use strict";

const { normalizePersonaTone } = require("./personaEngine");

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
    body.adminPhone !== undefined
      ? String(body.adminPhone || "").trim()
      : body.adminAlertWhatsapp !== undefined
        ? String(body.adminAlertWhatsapp || "").trim()
        : null;

  if (adminDigits !== null) {
    updateFields.adminPhone = adminDigits;
    updateFields["brand.adminPhone"] = adminDigits;
    updateFields.adminAlertWhatsapp = adminDigits;
    updateFields["platformVars.adminWhatsappNumber"] = adminDigits;
  }

  if (body.adminEmail !== undefined) {
    updateFields["platformVars.supportEmail"] = String(body.adminEmail || "").trim();
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
  return {
    businessName: pv.brandName || client.businessName || client.name || "",
    botName: pv.agentName || persona.name || client.nicheData?.botName || "",
    supportPhone: pv.supportWhatsapp || pv.supportPhone || "",
    tone: persona.tone || pv.defaultTone || "friendly",
    botLanguage: persona.language || pv.defaultLanguage || "English",
    businessLogo: client.businessLogo || client.brand?.businessLogo || client.brand?.logoUrl || "",
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
