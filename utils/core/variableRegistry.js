"use strict";

/**
 * MASTER VARIABLE REGISTRY — single catalogue for {{name}} placeholders.
 * `source` is resolved via resolveSourcePath against { client, convo, lead }.
 * `computed.*` is filled in buildVariableContext after path resolution.
 */

const {
  SHOPIFY_ACTION_CATEGORY,
  SHOPIFY_ACTION_VARIABLES,
} = require("../../constants/shopifyActionVariables");

const REMOVED_LEGACY_NAMES = new Set([
  "cart_total",
  "cart_items",
  "checkout_url",
  "order_id",
  "order_number",
  "order_status",
  "tracking_url",
  "order_date",
  "order_total",
  "shipping_address",
]);

const CORE_VARIABLE_REGISTRY = [
  // ── BRAND ─────────────────────────────────────────────────────────────
  { name: "brand_name", label: "Brand name", category: "Brand",
    source: "client.platformVars.brandName", wizardField: "businessName",
    fallback: "Our Store", preview: "Delitech Smart Home" },
  { name: "bot_name", label: "Bot name", category: "Brand",
    source: "client.platformVars.agentName", wizardField: "botName",
    fallback: "Assistant", preview: "Vedanta" },
  { name: "brand_logo_url", label: "Brand logo URL", category: "Brand",
    source: "client.brand.businessLogo", wizardField: "businessLogo",
    fallback: "", preview: "https://cdn.example.com/logo.png" },
  { name: "support_phone", label: "Support phone", category: "Brand",
    source: "client.platformVars.supportWhatsapp", wizardField: "supportPhone",
    fallback: "", preview: "+91 98765 43210" },
  { name: "store_url", label: "Store URL", category: "Brand",
    source: "client.platformVars.checkoutUrl", wizardField: "checkoutUrl",
    fallback: "", preview: "https://mystore.myshopify.com" },
  { name: "open_hours", label: "Business hours", category: "Brand",
    source: "computed.openHours", wizardField: "openTime+closeTime",
    fallback: "10:00–19:00", preview: "10:00–19:00" },
  { name: "currency", label: "Currency symbol", category: "Brand",
    source: "client.brand.currency", wizardField: "currency",
    fallback: "₹", preview: "₹" },
  { name: "warranty_duration", label: "Warranty duration", category: "Brand",
    source: "computed.warrantyDuration", wizardField: "warrantyDuration",
    fallback: "1 Year", preview: "1 Year" },
  { name: "google_review_url", label: "Google review URL", category: "Brand",
    source: "client.platformVars.googleReviewUrl", wizardField: "googleReviewUrl",
    fallback: "", preview: "https://g.page/r/review" },
  { name: "referral_points", label: "Referral bonus points", category: "Brand",
    source: "computed.referralPoints", wizardField: "referralPoints",
    fallback: "500", preview: "500" },
  { name: "support_email", label: "Support email", category: "Brand",
    source: "client.platformVars.supportEmail", wizardField: "supportEmail",
    fallback: "", preview: "support@brand.com" },

  // ── CUSTOMER (lead + convo) ────────────────────────────────────────────
  { name: "customer_name", label: "Customer name", category: "Customer",
    source: "lead.name", wizardField: null,
    fallback: "Friend", preview: "Rahul Sharma" },
  { name: "first_name", label: "First name", category: "Customer",
    source: "computed.firstName", wizardField: null,
    fallback: "Friend", preview: "Rahul" },
  { name: "customer_phone", label: "Customer phone", category: "Customer",
    source: "lead.phoneNumber", wizardField: null,
    fallback: "", preview: "+91 98765 43210" },
  { name: "customer_email", label: "Customer email", category: "Customer",
    source: "lead.email", wizardField: null,
    fallback: "", preview: "rahul@example.com" },
  { name: "customer_city", label: "Customer city", category: "Customer",
    source: "lead.city", wizardField: null,
    fallback: "", preview: "Mumbai" },
  // ── ORDER / COMMERCE (non–Shopify-Action globals) ───────────────────────
  { name: "order_items", label: "Order items summary", category: "Order",
    source: "computed.orderItems", wizardField: null,
    fallback: "your items", preview: "Smart Doorbell × 1" },
  { name: "cart_items_count", label: "Cart item count", category: "Order",
    source: "convo.metadata.cart_items_count", wizardField: null,
    fallback: "", preview: "2" },
  { name: "payment_method", label: "Payment method", category: "Order",
    source: "convo.metadata.payment_method", wizardField: null,
    fallback: "", preview: "COD" },
  { name: "product_name", label: "Product name", category: "Order",
    source: "convo.metadata.first_product_title", wizardField: null,
    fallback: "", preview: "Smart Doorbell" },
  { name: "first_product_title", label: "First line item title", category: "Order",
    source: "convo.metadata.first_product_title", wizardField: null,
    fallback: "", preview: "Smart Doorbell" },
  { name: "first_product_image", label: "Product image URL", category: "Order",
    source: "convo.metadata.first_product_image", wizardField: null,
    fallback: "", preview: "https://cdn.example.com/product.jpg" },
  { name: "line_items_list", label: "Line items summary", category: "Order",
    source: "convo.metadata.line_items_list", wizardField: null,
    fallback: "your items", preview: "Doorbell × 1" },
  { name: "estimated_delivery", label: "Estimated delivery", category: "Order",
    source: "computed.estimatedDelivery", wizardField: null,
    fallback: "3–5 business days", preview: "15 May 2026" },
  // ── CAPTURED ────────────────────────────────────────────────────────────
  { name: "captured_email", label: "Captured email", category: "Captured",
    source: "convo.metadata.captured_email", wizardField: null, fallback: "", preview: "u@x.com" },
  { name: "cancel_reason", label: "Cancellation reason", category: "Captured",
    source: "convo.metadata.cancel_reason", wizardField: null, fallback: "", preview: "Mistake" },
  { name: "return_reason", label: "Return reason", category: "Captured",
    source: "convo.metadata.return_reason", wizardField: null, fallback: "", preview: "Damaged" },
  { name: "warranty_serial", label: "Warranty serial", category: "Captured",
    source: "convo.metadata.warranty_serial", wizardField: null, fallback: "", preview: "DL-2024" },
  { name: "support_query", label: "Support query", category: "Captured",
    source: "convo.metadata.support_query", wizardField: null, fallback: "", preview: "Help" },

  // ── SYSTEM ───────────────────────────────────────────────────────────────
  { name: "user_last_response", label: "User's last response", category: "System",
    source: "convo.metadata.user_last_response", wizardField: null, fallback: "", preview: "I want to check my order status" },
  { name: "current_date", label: "Today's date", category: "System",
    source: "computed.currentDate", wizardField: null, fallback: "", preview: "3 May 2026" },
  { name: "current_time", label: "Current time", category: "System",
    source: "computed.currentTime", wizardField: null, fallback: "", preview: "14:32" },
  { name: "discount_code", label: "Discount code", category: "System",
    source: "convo.metadata.discount_code", wizardField: null, fallback: "", preview: "SAVE10" },
  { name: "payment_link", label: "Payment link", category: "System",
    source: "convo.metadata.payment_link", wizardField: null, fallback: "", preview: "https://rzp.io/..." },
];

const SHOPIFY_ACTION_REGISTRY = SHOPIFY_ACTION_VARIABLES.map((v) => ({
  name: v.name,
  label: v.label,
  category: SHOPIFY_ACTION_CATEGORY,
  description: v.description,
  preview: v.preview,
  shopifyActionOnly: true,
  locked: true,
  source: null,
  wizardField: null,
  fallback: "NA",
}));

const VARIABLE_REGISTRY = [...CORE_VARIABLE_REGISTRY, ...SHOPIFY_ACTION_REGISTRY];

function resolveSourcePath(path, sources) {
  if (!path || typeof path !== "string") return null;
  const parts = path.split(".").filter(Boolean);
  const root = parts.shift();
  const obj = sources[root];
  if (obj == null) return null;
  return parts.reduce((o, k) => (o != null && o[k] !== undefined ? o[k] : null), obj);
}

module.exports = { VARIABLE_REGISTRY, resolveSourcePath, REMOVED_LEGACY_NAMES };
