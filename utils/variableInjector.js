"use strict";

const Order = require("../models/Order");

/**
 * VARIABLE INJECTOR — Phase 20 (Full Replacement)
 * 
 * Usage:
 *   const ctx = await buildVariableContext(client, phone, convo, lead);
 *   const text = injectVariables("Hello {{customer_name}}!", ctx);
 *   const node = injectNodeVariables(node, ctx);
 */

/**
 * Build the full variable context for a conversation.
 * Called ONCE per incoming message at the top of runDualBrainEngine.
 * Returns a flat object of all variables available for injection.
 */
async function buildVariableContext(client, phone, convo, lead) {
  // Fetch latest order for this phone number
  let latest = null;
  try {
    latest = await Order.findOne({
      $or: [
        { phone, clientId: client.clientId },
        { clientId: client.clientId, customerPhone: phone }
      ]
    }).sort({ createdAt: -1 }).lean();
  } catch (_) {}

  // India timezone dates
  const now_ist = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const date_ist = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium"
  });
  const time_ist = new Date().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    timeStyle: "short"
  });

  // Cart info from lead snapshot
  const cartItems = (lead?.cartSnapshot?.titles || lead?.cartSnapshot?.items?.map(i => i.title) || []).join(", ");
  const cartTotal = lead?.cartSnapshot?.total_price || lead?.cartValue || 0;
  const cartTotalFormatted = cartTotal ? `₹${Number(cartTotal).toLocaleString("en-IN")}` : "₹0";

  // Order info
  const orderTotal = latest?.totalPrice || latest?.amount || 0;
  const orderTotalFormatted = orderTotal ? `₹${Number(orderTotal).toLocaleString("en-IN")}` : "";

  // Lifetime value
  const lifetimeValue = lead?.lifetimeValue || 0;
  const totalSpent = lifetimeValue ? `₹${Number(lifetimeValue).toLocaleString("en-IN")}` : "₹0";

  // Checkout URL
  const storeUrl = client.nicheData?.storeUrl || client.shopDomain ? `https://${client.shopDomain}` : "";
  const checkoutUrl = lead?.checkoutUrl || (lead?.cartSnapshot?.token
    ? `${storeUrl}/cart/${lead.cartSnapshot.token}?utm_source=whatsapp`
    : storeUrl);

  // Discount codes
  const discountCode = lead?.activeDiscountCode || convo?.metadata?.discount_code || "";

  // Build context — system variables
  const systemContext = {
    // ── Customer ──────────────────────────────────────────────────────
    customer_name:   lead?.name || convo?.customerName || convo?.metadata?.customer_name || "there",
    first_name:      (lead?.name || convo?.customerName || "there").split(" ")[0],
    customer_phone:  phone || "",
    email:           lead?.email || convo?.metadata?.email || "",
    city:            lead?.city || convo?.metadata?.city || "",
    lead_score:      String(lead?.leadScore || lead?.score || 0),
    total_spent:     totalSpent,
    orders_count:    String(lead?.ordersCount || 0),

    // ── Business ──────────────────────────────────────────────────────
    brand_name:      client.businessName || client.name || "",
    store_url:       storeUrl,
    business_hours:  client.nicheData?.businessHours || client.workingHours?.hours
                       ? "Mon-Sat 9AM-7PM"
                       : "Mon-Sat 9AM-7PM",
    agent_name:      client.nicheData?.botName || client.config?.agentName || "AI Assistant",

    // ── System ────────────────────────────────────────────────────────
    current_time:    time_ist,
    current_date:    date_ist,
    current_datetime: now_ist,

    // ── Cart ──────────────────────────────────────────────────────────
    cart_total:      cartTotalFormatted,
    cart_items:      cartItems,
    checkout_url:    checkoutUrl,

    // ── Order ─────────────────────────────────────────────────────────
    order_id:        latest?.orderNumber ? `#${latest.orderNumber}` : (latest?.orderId || ""),
    order_total:     orderTotalFormatted,
    order_status:    latest?.status || latest?.fulfillmentStatus || "",
    tracking_url:    latest?.trackingUrl || "",
    payment_method:  latest?.paymentMethod || "",
    payment_link:    latest?.razorpayUrl || latest?.cashfreeUrl || convo?.metadata?.payment_link || "",

    // ── Promo ─────────────────────────────────────────────────────────
    discount_code:   discountCode,
    discount_value:  lead?.activeDiscountValue ? `${lead.activeDiscountValue}%` : "",
    discount_amount: String(
      client.automationFlows?.find(f => f.id === "cod_to_prepaid")?.config?.discountAmount || 50
    ),
  };

  // Merge: captured variables from lead.capturedData and convo.metadata OVERRIDE system variables
  // (so if someone captures {{customer_name}} it updates the value)
  return {
    ...systemContext,
    ...(lead?.capturedData || {}),
    ...(convo?.metadata || {}),
  };
}

/**
 * Replace all {{variable}} placeholders in a text string.
 * Supports fallback pipes: {{variable_name | 'Fallback Value'}}
 * 
 * @param {string} text    - Text containing {{variable}} placeholders
 * @param {Object} context - Flat context object from buildVariableContext()
 * @returns {string}
 */
function injectVariables(text, context) {
  if (!text || typeof text !== "string") return text;
  if (!context || typeof context !== "object") return text;

  // Robust Regex: handles {{var}}, {{var | 'fallback'}}, {{var|fallback}}, etc.
  const variableRegex = /{{\s*([\w.]+)\s*(?:\|\s*['"]?([^'"]*)['"]?\s*)?}}/g;

  return text.replace(variableRegex, (match, key, fallback) => {
    // 1. Check direct context (e.g. {{customer_name}})
    let value = context[key];

    // 2. Support nested path notation (e.g. {{lead.name}})
    if (value === undefined && key.includes('.')) {
      const parts = key.split('.');
      let current = context;
      for (const part of parts) {
        current = current?.[part];
      }
      value = current;
    }

    // 3. Resolve value or fallback
    if (value !== undefined && value !== null && String(value) !== "") {
      return String(value);
    }

    // If no value, use fallback if provided, otherwise keep match
    if (fallback !== undefined && fallback !== null) {
      return fallback;
    }

    return match; // Keep {{unknown_var}} as-is
  });
}

/**
 * Deep-inject variables into ALL fields of a node's data object recursively.
 * Returns a NEW object with variables resolved.
 * 
 * @param {any} target     - Target object or value (usually node.data)
 * @param {Object} context - Variable context from buildVariableContext()
 * @returns {any}          - New object/value with all text fields resolved
 */
function injectNodeVariables(target, context) {
  if (!target || !context) return target;

  const injectDeep = (obj) => {
    // String: Inject variables
    if (typeof obj === "string") return injectVariables(obj, context);
    
    // Array: Recursively process items
    if (Array.isArray(obj)) return obj.map(item => injectDeep(item));
    
    // Object: Recursively process keys
    if (obj !== null && typeof obj === "object" && obj.constructor === Object) {
      const result = {};
      for (const [key, val] of Object.entries(obj)) {
        result[key] = injectDeep(val);
      }
      return result;
    }
    
    // Primitive or other types: return as-is
    return obj;
  };

  // If passed a full node, return a copy with injected data
  if (target.id && target.data) {
    return { ...target, data: injectDeep(target.data) };
  }

  return injectDeep(target);
}

/**
 * Legacy-compatible wrapper used by existing replaceVariables() call sites.
 * Accepts either the new flat context OR the old {lead, client, convo, order} shape.
 */
function injectVariablesLegacy(text, contextOrLegacy) {
  if (!text || typeof text !== "string") return text;

  // Detect if old-style object is passed: { lead, client, convo, order }
  if (
    contextOrLegacy &&
    typeof contextOrLegacy === "object" &&
    ("lead" in contextOrLegacy || "client" in contextOrLegacy || "convo" in contextOrLegacy)
  ) {
    // Build a minimal flat context from the legacy object
    const { lead, client, convo, order } = contextOrLegacy;
    const legacyCtx = {
      name:            lead?.name || "Customer",
      customer_name:   lead?.name || "Customer",
      first_name:      (lead?.name || "Customer").split(" ")[0],
      phone:           lead?.phoneNumber || convo?.phone || "",
      customer_phone:  lead?.phoneNumber || convo?.phone || "",
      email:           lead?.email || "",
      business_name:   client?.name || client?.businessName || "",
      brand_name:      client?.businessName || "",
      order_id:        order?.orderNumber ? `#${order.orderNumber}` : (order?.orderId || ""),
      order_status:    order?.status || "",
      order_total:     order?.totalPrice ? `₹${order.totalPrice}` : "",
      tracking_link:   order?.trackingUrl || "",
      tracking_url:    order?.trackingUrl || "",
      payment_link:    order?.razorpayUrl || order?.cashfreeUrl || "",
      cart_total:      lead?.cartValue || "",
      checkout_url:    lead?.checkoutUrl || "",
      discount_code:   lead?.activeDiscountCode || "",
      ...(convo?.metadata || {}),
    };
    return injectVariables(text, legacyCtx);
  }

  // New-style flat context
  return injectVariables(text, contextOrLegacy || {});
}

module.exports = {
  buildVariableContext,
  injectVariables,
  injectNodeVariables,
  injectVariablesLegacy,
};
