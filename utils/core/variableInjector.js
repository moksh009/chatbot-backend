"use strict";

const Order = require("../../models/Order");
const { normalizePhone } = require('./helpers');
const { RESOLVABLE_VARIABLE_REGISTRY, VARIABLE_REGISTRY, resolveSourcePath, REMOVED_LEGACY_NAMES } = require('./variableRegistry');
const {
  SHOPIFY_ACTION_VARIABLE_NAMES,
} = require('../../constants/shopifyActionVariables');
const { applyTenantCustomVariableDefaults } = require('./variableUtils');

function stripBlockedVariableKeys(obj = {}) {
  const out = { ...obj };
  for (const key of Object.keys(out)) {
    if (REMOVED_LEGACY_NAMES.has(key) || SHOPIFY_ACTION_VARIABLE_NAMES.has(key)) {
      delete out[key];
    }
  }
  return out;
}

function _get(obj, path) {
  if (!obj || !path) return null;
  return path.split(".").reduce((o, k) => (o != null && o[k] !== undefined ? o[k] : null), obj);
}

/**
 * Build the full variable context for a conversation.
 * @param {Object} client - lean or doc
 * @param {string} phone
 * @param {Object} convo
 * @param {Object} lead
 */
async function buildVariableContext(client, phone, convo, lead) {
  const clientLean = client?.toObject ? client.toObject() : client || {};
  const convoLean = convo?.toObject ? convo.toObject() : convo || {};
  const leadLean = lead?.toObject ? lead.toObject() : lead || {};
  const normPhone = normalizePhone(phone);

  let latest = null;
  try {
    latest = await Order.findOne({
      $or: [
        { phone: normPhone, clientId: clientLean.clientId },
        { clientId: clientLean.clientId, customerPhone: normPhone },
        { phone, clientId: clientLean.clientId },
        { clientId: clientLean.clientId, customerPhone: phone },
      ],
    })
      .sort({ createdAt: -1 })
      .lean();
  } catch (_) {}

  let dna = null;
  try {
    const CustomerIntelligence = require("../../models/CustomerIntelligence");
    dna = await CustomerIntelligence.findOne({ clientId: clientLean.clientId, phone }).lean();
  } catch (_) {}

  const meta = convoLean.metadata || {};
  const lastOrder = meta.lastOrder || {};

  const dateIN = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
  const timeIN = new Date().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });

  const bhOpen = _get(clientLean, "config.businessHours.openTime") || clientLean.platformVars?.openTime;
  const bhClose = _get(clientLean, "config.businessHours.closeTime") || clientLean.platformVars?.closeTime;
  const openHoursStr =
    bhOpen && bhClose ? `${bhOpen}–${bhClose}` : (clientLean.platformVars?.openTime && clientLean.platformVars?.closeTime
      ? `${clientLean.platformVars.openTime}–${clientLean.platformVars.closeTime}`
      : null);

  const wf = clientLean.wizardFeatures?.toObject ? clientLean.wizardFeatures.toObject() : (clientLean.wizardFeatures || {});
  const codDiscount = wf.codDiscountAmount
    ?? clientLean.automationFlows?.find((f) => f.id === "cod_to_prepaid")?.config?.discountAmount
    ?? 50;

  const orderItemsStr =
    lastOrder.itemsSummary
    || meta.line_items_list
    || "";

  const storeUrl =
    clientLean.nicheData?.storeUrl
    || (clientLean.shopDomain ? `https://${String(clientLean.shopDomain).replace(/^https?:\/\//, "")}` : "");

  const firstNameComputed =
    meta.first_name
    || (leadLean?.name || convoLean?.customerName || "Friend").split(/\s+/)[0];

  const sources = {
    client: clientLean,
    convo: convoLean,
    lead: leadLean,
    computed: {
      openHours: openHoursStr,
      currentDate: dateIN,
      currentTime: timeIN,
      firstName: firstNameComputed,
      warrantyDuration:
        clientLean.platformVars?.warrantyDuration
        || clientLean.brand?.warrantyDefaultDuration
        || wf.warrantyDuration
        || "1 Year",
      orderItems: orderItemsStr,
      referralPoints: wf.referralPointsBonus ?? 500,
      estimatedDelivery: "3–5 business days",
    }
  };

  const pv = clientLean.platformVars || {};
  const ctx = {};
  for (const def of RESOLVABLE_VARIABLE_REGISTRY) {
    if (def.shopifyActionOnly) continue;
    let v = null;
    if (def.source && def.source.startsWith("computed.")) {
      const key = def.source.slice("computed.".length);
      v = sources.computed[key];
    } else {
      v = resolveSourcePath(def.source, sources);
    }
    if (v === null || v === undefined || String(v).trim() === "") {
      v = def.fallback;
    }
    ctx[def.name] = v != null ? String(v) : "";
  }

  // Customer-facing support line (wizard Brand step) — not admin alert number
  const supportLine = String(
    pv.supportWhatsapp || pv.supportPhone || clientLean.supportPhone || clientLean.adminPhone || ""
  ).trim();
  if (supportLine) ctx.support_phone = supportLine;
  if (!ctx.google_review_url?.trim()) {
    ctx.google_review_url = String(
      pv.googleReviewUrl || clientLean.googleReviewUrl || clientLean.brand?.googleReviewUrl || ""
    ).trim();
  }

  if (!ctx.payment_method && latest?.paymentMethod) {
    ctx.payment_method = String(latest.paymentMethod);
  }
  if (!ctx.payment_link && (latest?.razorpayUrl || latest?.cashfreeUrl)) {
    ctx.payment_link = String(latest.razorpayUrl || latest.cashfreeUrl || "");
  }

  const discountCode = leadLean?.activeDiscountCode || meta.discount_code || "";
  const lifetimeValue = leadLean?.lifetimeValue || 0;

  let product_list_text = meta.product_list_text || "";
  const selCol = meta.selectedCollectionId || meta.selected_collection_id;
  if (selCol && clientLean.clientId && !product_list_text) {
    try {
      const ShopifyProduct = require("../../models/ShopifyProduct");
      const prods = await ShopifyProduct.find({
        clientId: String(clientLean.clientId),
        collectionIds: String(selCol),
        inStock: { $ne: false },
      })
        .sort({ updatedAt: -1 })
        .limit(20)
        .lean();
      const cur = clientLean.platformVars?.baseCurrency || "₹";
      product_list_text = (prods || [])
        .map((p, i) => {
          const pr = p.price != null ? Number(p.price).toLocaleString("en-IN") : "—";
          const url =
            p.productUrl ||
            p.onlineStoreUrl ||
            (clientLean.shopDomain
              ? `https://${String(clientLean.shopDomain).replace(/^https?:\/\//, "")}/products/${p.handle || ""}`
              : "");
          return `${i + 1}. *${p.title || "Item"}*\n   Price: ${cur}${pr}\n   ${url}`;
        })
        .join("\n\n");
    } catch (_) {
      product_list_text = "";
    }
  }
  const selected_category_name =
    meta.selected_category_name
    || meta.collection_title
    || "Selected category";

  // Legacy flat keys (dualBrainEngine, campaigns, older templates)
  const legacy = {
    customer_name: ctx.customer_name || leadLean?.name || convoLean?.customerName || "there",
    first_name: ctx.first_name,
    email: ctx.customer_email || leadLean?.email || meta.email || "",
    city: ctx.customer_city || leadLean?.city || meta.city || "",
    agent_name: ctx.bot_name,
    bot_name: ctx.bot_name,
    brand_name: ctx.brand_name,
    admin_whatsapp: clientLean.adminPhone || pv.adminWhatsappNumber || "",
    support_phone: ctx.support_phone,
    supportPhone: ctx.support_phone,
    googleReviewUrl: ctx.google_review_url,
    business_hours: ctx.open_hours,
    open_hours: ctx.open_hours,
    base_currency: ctx.currency,
    store_url: ctx.store_url || storeUrl,
    lead_score: String(leadLean?.leadScore || leadLean?.score || 0),
    total_spent: lifetimeValue ? `₹${Number(lifetimeValue).toLocaleString("en-IN")}` : "₹0",
    orders_count: String(leadLean?.ordersCount || 0),
    current_datetime: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    sentiment: convoLean?.sentiment || "Neutral",
    sentiment_score: String(convoLean?.sentimentScore || 0),
    discount_code: discountCode,
    discount_value: leadLean?.activeDiscountValue ? `${leadLean.activeDiscountValue}%` : "",
    discount_amount: String(codDiscount),
    review_url: ctx.google_review_url || clientLean.brand?.googleReviewUrl || "",
    ad_id: leadLean?.adAttribution?.adId || "",
    ad_name: leadLean?.adAttribution?.adHeadline || "",
    ad_source: leadLean?.adAttribution?.source || "",
    persona: dna?.persona || "unknown",
    ai_summary: dna?.aiSummary || "",
    engagement_score: String(dna?.engagementScore || 0),
    churn_risk: String(dna?.churnRiskScore || 0),
    line_items_list: orderItemsStr,
    first_product_title: meta.first_product_title || "",
    first_product_image: meta.first_product_image || "",
    product_list_text: product_list_text || "Catalog is syncing — our team can share product links on request.",
    selected_category_name,
  };

  const profileName = (leadLean?.name || convoLean?.customerName || "").trim();
  const metaForMerge = stripBlockedVariableKeys({ ...(meta || {}) });
  if (profileName) {
    delete metaForMerge.customer_name;
  }
  const merged = {
    ...legacy,
    ...ctx,
    ...(leadLean?.capturedData || {}),
    ...metaForMerge,
  };
  const capturedFlows = leadLean?.capturedData?.flows;
  if (capturedFlows && typeof capturedFlows === 'object' && !Array.isArray(capturedFlows)) {
    merged.flows = capturedFlows;
    for (const [fid, fdata] of Object.entries(capturedFlows)) {
      if (!fdata || typeof fdata !== 'object') continue;
      for (const [k, v] of Object.entries(fdata)) {
        merged[`flows.${fid}.${k}`] = v;
      }
    }
  }
  if (profileName) {
    merged.customer_name = profileName;
    merged.first_name = profileName.split(/\s+/)[0] || merged.first_name;
  }
  return stripBlockedVariableKeys(
    applyTenantCustomVariableDefaults(merged, clientLean)
  );
}

function injectVariables(text, context) {
  if (!text || typeof text !== "string") return text;
  if (!context || typeof context !== "object") return text;

  const variableRegex = /{{\s*([\w.]+)\s*(?:\|\s*['"]?([^'"]*)['"]?\s*)?}}/g;

  return text.replace(variableRegex, (match, key, fallback) => {
    if (!/^[\w.]+$/.test(key)) {
      return match;
    }

    let value = context[key];

    if (value === undefined && key.includes(".")) {
      const parts = key.split(".");
      let current = context;
      for (const part of parts) {
        current = current?.[part];
      }
      value = current;
    }

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value);
    }

    if (fallback !== undefined && fallback !== null) {
      return fallback;
    }

    return "-";
  });
}

function injectNodeVariables(target, context) {
  if (!target || !context) return target;

  const injectDeep = (obj) => {
    if (typeof obj === "string") return injectVariables(obj, context);
    if (Array.isArray(obj)) return obj.map((item) => injectDeep(item));
    if (obj !== null && typeof obj === "object" && obj.constructor === Object) {
      const result = {};
      for (const [key, val] of Object.entries(obj)) {
        result[key] = injectDeep(val);
      }
      return result;
    }
    return obj;
  };

  if (target.id && target.data) {
    return { ...target, data: injectDeep(target.data) };
  }

  return injectDeep(target);
}

function injectShopifyActionMessage(text, shopifyVars = {}, contextOrLegacy = {}) {
  if (!text || typeof text !== "string") return text;

  let baseCtx = {};
  if (contextOrLegacy && typeof contextOrLegacy === "object") {
    if ("lead" in contextOrLegacy || "client" in contextOrLegacy || "convo" in contextOrLegacy) {
      const { lead, client, convo } = contextOrLegacy;
      baseCtx = {
        name: lead?.name || "Customer",
        customer_name: lead?.name || convo?.customerName || "Customer",
        first_name: (lead?.name || convo?.customerName || "Customer").split(" ")[0],
        phone: lead?.phoneNumber || convo?.phone || "",
        customer_phone: lead?.phoneNumber || convo?.phone || "",
        email: lead?.email || "",
        business_name: client?.name || client?.businessName || "",
        brand_name: client?.businessName || client?.platformVars?.brandName || "",
        bot_name: client?.platformVars?.agentName || "",
        store_url: client?.platformVars?.checkoutUrl || "",
      };
    } else {
      baseCtx = { ...contextOrLegacy };
    }
  }

  const merged = { ...baseCtx, ...shopifyVars };

  const variableRegex = /{{\s*([\w.]+)\s*(?:\|\s*['"]?([^'"]*)['"]?\s*)?}}/g;
  return text.replace(variableRegex, (match, key, fallback) => {
    if (!/^[\w.]+$/.test(key)) return match;
    const value = merged[key];
    if (value !== undefined && value !== null && String(value).trim() !== "" && String(value).trim() !== "NA") {
      return String(value);
    }
    if (SHOPIFY_ACTION_VARIABLE_NAMES.has(key)) {
      if (fallback !== undefined && fallback !== null) return fallback;
      return "NA";
    }
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value);
    }
    if (fallback !== undefined && fallback !== null) return fallback;
    return "-";
  });
}

function injectVariablesLegacy(text, contextOrLegacy) {
  if (!text || typeof text !== "string") return text;

  if (
    contextOrLegacy &&
    typeof contextOrLegacy === "object" &&
    ("lead" in contextOrLegacy || "client" in contextOrLegacy || "convo" in contextOrLegacy)
  ) {
    const { lead, client, convo } = contextOrLegacy;
    const legacyCtx = stripBlockedVariableKeys({
      name: lead?.name || "Customer",
      customer_name: lead?.name || "Customer",
      first_name: (lead?.name || "Customer").split(" ")[0],
      phone: lead?.phoneNumber || convo?.phone || "",
      customer_phone: lead?.phoneNumber || convo?.phone || "",
      email: lead?.email || "",
      business_name: client?.name || client?.businessName || "",
      brand_name: client?.businessName || "",
      payment_link: convo?.metadata?.payment_link || "",
      discount_code: lead?.activeDiscountCode || "",
      ...(convo?.metadata || {}),
    });
    return injectVariables(text, legacyCtx);
  }

  return injectVariables(text, stripBlockedVariableKeys(contextOrLegacy || {}));
}

async function resolveFlowVariables(input, clientId, phone) {
  if (!input || !clientId || !phone) return input;

  try {
    const Client = require("../../models/Client");
    const Conversation = require("../../models/Conversation");
    const AdLead = require("../../models/AdLead");

    const [client, convo, lead] = await Promise.all([
      Client.findOne({ clientId }).lean(),
      Conversation.findOne({ clientId, phone }).lean(),
      AdLead.findOne({ clientId, phone }).lean()
    ]);

    if (!client) return input;

    const context = await buildVariableContext(client, phone, convo, lead);

    if (typeof input === "string") {
      return injectVariables(input, context);
    }
    if (typeof input === "object") {
      return injectNodeVariables(input, context);
    }

    return input;
  } catch (err) {
    console.error(`[VariableInjector] resolveFlowVariables error:`, err);
    return input;
  }
}

module.exports = {
  buildVariableContext,
  injectVariables,
  injectNodeVariables,
  injectVariablesLegacy,
  injectShopifyActionMessage,
  resolveFlowVariables,
  VARIABLE_REGISTRY,
  stripBlockedVariableKeys,
};
