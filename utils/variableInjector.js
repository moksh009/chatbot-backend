"use strict";

const Order = require("../models/Order");
const { normalizePhone } = require("./helpers");
const { VARIABLE_REGISTRY, resolveSourcePath } = require("./variableRegistry");

/**
 * VARIABLE INJECTOR — registry-backed context + legacy flat aliases for dualBrainEngine.
 */

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
    const CustomerIntelligence = require("../models/CustomerIntelligence");
    dna = await CustomerIntelligence.findOne({ clientId: clientLean.clientId, phone }).lean();
  } catch (_) {}

  let wallet = null;
  try {
    const CustomerWallet = require("../models/CustomerWallet");
    wallet = await CustomerWallet.findOne({
      clientId: clientLean.clientId,
      phone: normPhone,
    }).lean();
    if (!wallet && phone !== normPhone) {
      wallet = await CustomerWallet.findOne({ clientId: clientLean.clientId, phone }).lean();
    }
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

  const pointsPerCur = clientLean.loyaltyConfig?.pointsPerCurrency || clientLean.loyaltyConfig?.currencyUnit || 100;
  const loyaltyBal = wallet?.balance ?? 0;
  const loyaltyCash = `₹${Math.floor(loyaltyBal / (pointsPerCur || 100))}`;

  const orderNumFlat = meta.order_number || lastOrder.orderNumber || "";
  const orderIdDisplay = orderNumFlat
    ? (String(orderNumFlat).startsWith("#") ? String(orderNumFlat) : `#${orderNumFlat}`)
    : (latest?.orderNumber ? `#${latest.orderNumber}` : (latest?.orderId || ""));

  const orderTotalStr =
    lastOrder.totalPrice
    || meta.order_total_raw
    || latest?.totalPrice
    || "";
  const orderItemsStr =
    lastOrder.itemsSummary
    || meta.line_items_list
    || "";
  const orderStatusStr =
    lastOrder.status
    || latest?.status
    || latest?.fulfillmentStatus
    || meta.order_status_detail
    || "";
  const trackingUrlStr = lastOrder.trackingUrl || latest?.trackingUrl || "";

  const cartSnap = leadLean?.cartSnapshot;
  const cartItemsJoin = (cartSnap?.titles || cartSnap?.items?.map((i) => i.title) || []).join(", ");
  const cartTotalRaw = leadLean?.cartSnapshot?.total_price ?? leadLean?.cartValue ?? meta.cart_total ?? "";
  const cartTotalFmt = cartTotalRaw !== "" && cartTotalRaw != null
    ? `${clientLean.platformVars?.baseCurrency || "₹"}${Number(cartTotalRaw).toLocaleString("en-IN")}`
    : (meta.cart_total || "");

  const storeUrl =
    clientLean.nicheData?.storeUrl
    || (clientLean.shopDomain ? `https://${String(clientLean.shopDomain).replace(/^https?:\/\//, "")}` : "");
  const checkoutUrl =
    leadLean?.checkoutUrl
    || (leadLean?.cartSnapshot?.token
      ? `${storeUrl}/cart/${leadLean.cartSnapshot.token}?utm_source=whatsapp`
      : (clientLean.platformVars?.checkoutUrl || storeUrl));

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
      loyaltyPoints: String(loyaltyBal),
      loyaltyTier: wallet?.tier || "Bronze",
      loyaltyCashValue: loyaltyCash,
      warrantyDuration:
        clientLean.platformVars?.warrantyDuration
        || clientLean.brand?.warrantyDefaultDuration
        || wf.warrantyDuration
        || "1 Year",
      orderIdDisplay,
      orderStatus: orderStatusStr,
      orderTotal: orderTotalStr ? String(orderTotalStr) : "",
      orderItems: orderItemsStr,
      trackingUrl: trackingUrlStr,
      cartTotal: cartTotalFmt,
      referralPoints:
        clientLean.loyaltyConfig?.referralBonus
        ?? wf.referralPointsBonus
        ?? 500,
    }
  };

  const ctx = {};
  for (const def of VARIABLE_REGISTRY) {
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

  // Enrich from Order model when metadata empty
  if (!ctx.order_id && latest) {
    ctx.order_id = latest.orderNumber ? `#${latest.orderNumber}` : String(latest.orderId || "");
  }
  if (!ctx.order_total && latest?.totalPrice) {
    ctx.order_total = String(latest.totalPrice);
  }
  if (!ctx.order_status && (latest?.status || latest?.fulfillmentStatus)) {
    ctx.order_status = String(latest.status || latest.fulfillmentStatus);
  }
  if (!ctx.tracking_url && latest?.trackingUrl) {
    ctx.tracking_url = String(latest.trackingUrl);
  }
  if (!ctx.payment_method && latest?.paymentMethod) {
    ctx.payment_method = String(latest.paymentMethod);
  }
  if (!ctx.payment_link && (latest?.razorpayUrl || latest?.cashfreeUrl)) {
    ctx.payment_link = String(latest.razorpayUrl || latest.cashfreeUrl || "");
  }

  const discountCode = leadLean?.activeDiscountCode || meta.discount_code || "";
  const lifetimeValue = leadLean?.lifetimeValue || 0;

  // Legacy flat keys (dualBrainEngine, campaigns, older templates)
  const legacy = {
    customer_name: ctx.customer_name || leadLean?.name || convoLean?.customerName || "there",
    first_name: ctx.first_name,
    email: ctx.customer_email || leadLean?.email || meta.email || "",
    city: ctx.customer_city || leadLean?.city || meta.city || "",
    agent_name: ctx.bot_name,
    bot_name: ctx.bot_name,
    brand_name: ctx.brand_name,
    admin_whatsapp: ctx.support_phone || clientLean.adminPhone || "",
    support_phone: ctx.support_phone,
    business_hours: ctx.open_hours,
    open_hours: ctx.open_hours,
    base_currency: ctx.currency,
    checkout_url: checkoutUrl,
    store_url: ctx.store_url || storeUrl,
    cart_items: cartItemsJoin || ctx.order_items,
    lead_score: String(leadLean?.leadScore || leadLean?.score || 0),
    total_spent: lifetimeValue ? `₹${Number(lifetimeValue).toLocaleString("en-IN")}` : "₹0",
    orders_count: String(leadLean?.ordersCount || 0),
    current_datetime: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    sentiment: convoLean?.sentiment || "Neutral",
    sentiment_score: String(convoLean?.sentimentScore || 0),
    discount_code: discountCode,
    discount_value: leadLean?.activeDiscountValue ? `${leadLean.activeDiscountValue}%` : "",
    discount_amount: String(codDiscount),
    loyalty_balance: ctx.loyalty_points,
    review_url: ctx.google_review_url || clientLean.brand?.googleReviewUrl || "",
    ad_id: leadLean?.adAttribution?.adId || "",
    ad_name: leadLean?.adAttribution?.adHeadline || "",
    ad_source: leadLean?.adAttribution?.source || "",
    persona: dna?.persona || "unknown",
    ai_summary: dna?.aiSummary || "",
    engagement_score: String(dna?.engagementScore || 0),
    churn_risk: String(dna?.churnRiskScore || 0),
    order_number: ctx.order_number || orderIdDisplay,
    line_items_list: orderItemsStr,
    first_product_title: meta.first_product_title || "",
    first_product_image: meta.first_product_image || "",
    shipping_address: meta.shipping_address || "",
  };

  return {
    ...legacy,
    ...ctx,
    ...(leadLean?.capturedData || {}),
    ...(meta || {})
  };
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

function injectVariablesLegacy(text, contextOrLegacy) {
  if (!text || typeof text !== "string") return text;

  if (
    contextOrLegacy &&
    typeof contextOrLegacy === "object" &&
    ("lead" in contextOrLegacy || "client" in contextOrLegacy || "convo" in contextOrLegacy)
  ) {
    const { lead, client, convo, order } = contextOrLegacy;
    const legacyCtx = {
      name: lead?.name || "Customer",
      customer_name: lead?.name || "Customer",
      first_name: (lead?.name || "Customer").split(" ")[0],
      phone: lead?.phoneNumber || convo?.phone || "",
      customer_phone: lead?.phoneNumber || convo?.phone || "",
      email: lead?.email || "",
      business_name: client?.name || client?.businessName || "",
      brand_name: client?.businessName || "",
      order_id: order?.orderNumber ? `#${order.orderNumber}` : (order?.orderId || ""),
      order_status: order?.status || "",
      order_total: order?.totalPrice ? `₹${order.totalPrice}` : "",
      tracking_link: order?.trackingUrl || "",
      tracking_url: order?.trackingUrl || "",
      payment_link: order?.razorpayUrl || order?.cashfreeUrl || "",
      cart_total: lead?.cartValue || "",
      checkout_url: lead?.checkoutUrl || "",
      discount_code: lead?.activeDiscountCode || "",
      ...(convo?.metadata || {})
    };
    return injectVariables(text, legacyCtx);
  }

  return injectVariables(text, contextOrLegacy || {});
}

async function resolveFlowVariables(input, clientId, phone) {
  if (!input || !clientId || !phone) return input;

  try {
    const Client = require("../models/Client");
    const Conversation = require("../models/Conversation");
    const AdLead = require("../models/AdLead");

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
  resolveFlowVariables,
  VARIABLE_REGISTRY
};
