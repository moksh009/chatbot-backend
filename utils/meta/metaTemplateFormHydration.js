"use strict";

const { getPrebuiltByKey } = require("../../constants/prebuiltTemplateLibrary");

const SAMPLE_VALUES = {
  first_name: "Priya",
  customer_name: "Priya Sharma",
  order_id: "#TE-1042",
  order_number: "#TE-1042",
  order_items: "Wireless Earbuds Pro",
  order_total: "₹2,499",
  shipping_address: "12 MG Road, Bangalore",
  brand_name: "Your Store",
  cart_total: "₹1,999",
  checkout_url: "https://checkout.example.com/cart",
  tracking_url: "https://track.example.com/TE-1042",
  estimated_delivery: "3–5 business days",
  google_review_url: "https://g.page/r/example/review",
  warranty_duration: "12 months",
  order_date: "16 May 2026",
};

function sampleForRegistryKey(key, brand) {
  if (key === "brand_name") return brand || SAMPLE_VALUES.brand_name;
  return SAMPLE_VALUES[key] || "Sample value";
}

function extractNumericVars(text) {
  const matches = String(text || "").match(/\{\{\s*(\d+)\s*\}\}/g) || [];
  return [...new Set(matches.map((m) => m.replace(/\D/g, "")))].sort((a, b) => Number(a) - Number(b));
}

function normalizeButtonsForForm(buttons = [], sampleContext = {}) {
  if (!Array.isArray(buttons)) return [];
  return buttons.map((b) => {
    if (b.buttonType) return b;
    const t = String(b.type || "").toUpperCase();
    if (t === "QUICK_REPLY") return { buttonType: "QUICK_REPLY", text: b.text || "Reply" };
    if (t === "URL") {
      let url = b.url || "";
      if (b.urlVariable && sampleContext[b.urlVariable]) {
        url = String(sampleContext[b.urlVariable]);
      }
      const dyn = /\{\{\d+\}\}/.test(url);
      return {
        buttonType: "URL",
        text: b.text || "Open",
        url,
        urlType: dyn ? "Dynamic" : "Static",
        sampleUrl: dyn ? url.replace(/\{\{\d+\}\}/, "https://example.com/path") : url,
      };
    }
    if (t === "PHONE_NUMBER") {
      return { buttonType: "PHONE_NUMBER", text: b.text || "Call", phoneNumber: b.phone_number || "+919876543210" };
    }
    return { buttonType: "QUICK_REPLY", text: b.text || "Reply" };
  });
}

function buildBodySamples(bodyText, variableMappings, brand) {
  const bodyMap = variableMappings?.body || variableMappings || {};
  const indices = extractNumericVars(bodyText);
  const bodySamples = [];
  const variableSamples = {};
  for (const n of indices) {
    const regKey = bodyMap[n] || bodyMap[String(n)];
    const sample = sampleForRegistryKey(regKey, brand);
    bodySamples.push(sample);
    variableSamples[`{{${n}}}`] = sample;
  }
  return { bodySamples, variableSamples };
}

/**
 * Build editor formData + denormalized fields from a library entry.
 */
function buildFormDataFromLibraryEntry(entry, client = {}) {
  const brand = client.businessName || client.brandName || "Your Store";
  const logo = client.nicheData?.businessLogo || client.businessLogo || "";
  const sampleContext = { brand_name: brand, first_product_image: logo };
  const { bodySamples, variableSamples } = buildBodySamples(entry.bodyText, entry.variableMappings, brand);

  let mediaSample = "None";
  let headerImageUrl = null;
  let headerText = null;
  const ht = String(entry.headerType || "NONE").toUpperCase();
  if (ht === "IMAGE") {
    mediaSample = "Image";
    headerImageUrl = logo || "https://via.placeholder.com/400x200?text=Product";
    sampleContext.first_product_image = headerImageUrl;
  } else if (ht === "TEXT" && entry.headerText) {
    headerText = entry.headerText;
  }

  const footerText =
    entry.footerText ||
    (String(entry.category || "").toUpperCase() === "MARKETING" ? "Reply STOP to unsubscribe" : null);

  return {
    formData: {
      variableType: "Number",
      mediaSample,
      headerImageUrl,
      headerText,
      bodyText: entry.bodyText,
      footerText,
      headerSamples: [],
      bodySamples,
      buttons: normalizeButtonsForForm(entry.buttons, sampleContext),
    },
    variableSamples,
    headerType: ht === "IMAGE" ? "IMAGE" : ht === "TEXT" ? "TEXT" : "NONE",
    headerValue: ht === "IMAGE" ? headerImageUrl : headerText || "",
    footerText,
    category: entry.category || "MARKETING",
    language: "en",
    name: entry.metaName || entry.key,
    templateKey: entry.key,
    autoTrigger: entry.autoTrigger || null,
    isPrebuilt: true,
    variableMappings: entry.variableMappings || null,
  };
}

/**
 * Hydrate formData on an existing MetaTemplate doc for MetaTemplateCreatorForm.
 */
function hydrateTemplateDocForEditor(doc, client = {}) {
  if (!doc) return null;
  const brand = client.businessName || client.brandName || "Your Store";
  if (doc.formData?.bodyText && String(doc.formData.bodyText).trim()) {
    return doc;
  }

  const entry = getPrebuiltByKey(doc.templateKey || doc.autoGenProductId || doc.name);
  const bodyText = doc.body || entry?.bodyText || "";
  const mappings = doc.variableMappings || entry?.variableMappings;
  const { bodySamples } = buildBodySamples(bodyText, mappings, brand);

  const ht = String(doc.headerType || entry?.headerType || "NONE").toUpperCase();
  let mediaSample = "None";
  let headerImageUrl = doc.formData?.headerImageUrl || null;
  let headerText = doc.formData?.headerText || null;
  if (ht === "IMAGE") {
    mediaSample = "Image";
    headerImageUrl = doc.headerValue || client.nicheData?.businessLogo || client.businessLogo || "";
  } else if (ht === "TEXT") {
    headerText = doc.headerValue || entry?.headerText || "";
  }

  return {
    ...doc,
    formData: {
      variableType: "Number",
      mediaSample,
      headerImageUrl,
      headerText,
      bodyText,
      footerText: doc.footerText || entry?.footerText || null,
      headerSamples: doc.formData?.headerSamples || [],
      bodySamples: doc.formData?.bodySamples?.length ? doc.formData.bodySamples : bodySamples,
      buttons: normalizeButtonsForForm(doc.buttons || doc.formData?.buttons || entry?.buttons || []),
    },
  };
}

/** Resolve {{1}} style body using library variableMappings + sample context. */
function resolvePositionalPreviewBody(bodyText, variableMappings, sampleContext, brand) {
  const bodyMap = variableMappings?.body || variableMappings || {};
  return String(bodyText || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
    const regKey = bodyMap[n] || bodyMap[String(n)];
    if (regKey && sampleContext[regKey] != null && String(sampleContext[regKey]).trim() !== "") {
      return String(sampleContext[regKey]);
    }
    if (regKey) return sampleForRegistryKey(regKey, brand);
    return sampleForRegistryKey(null, brand);
  });
}

module.exports = {
  buildFormDataFromLibraryEntry,
  hydrateTemplateDocForEditor,
  resolvePositionalPreviewBody,
  normalizeButtonsForForm,
  sampleForRegistryKey,
};
