"use strict";

/**
 * MASTER VARIABLE REGISTRY — single catalogue for {{name}} placeholders.
 * `source` is resolved via resolveSourcePath against { client, convo, lead }.
 * `computed.*` is filled in buildVariableContext after path resolution.
 */

const VARIABLE_REGISTRY = [
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
    source: "client.platformVars.adminWhatsappNumber", wizardField: "adminPhone",
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
  { name: "loyalty_points", label: "Loyalty points balance", category: "Customer",
    source: "computed.loyaltyPoints", wizardField: null,
    fallback: "0", preview: "250" },
  { name: "loyalty_tier", label: "Loyalty tier", category: "Customer",
    source: "computed.loyaltyTier", wizardField: null,
    fallback: "Bronze", preview: "Silver" },
  { name: "loyalty_cash_value", label: "Loyalty cash value", category: "Customer",
    source: "computed.loyaltyCashValue", wizardField: null,
    fallback: "₹0", preview: "₹50" },
  { name: "points_per_currency", label: "Points per currency unit", category: "Customer",
    source: "client.loyaltyConfig.pointsPerUnit", wizardField: null,
    fallback: "100", preview: "100" },

  // ── ORDER / COMMERCE (metadata.lastOrder + legacy flat keys) ───────────
  { name: "order_id", label: "Order ID", category: "Order",
    source: "computed.orderIdDisplay", wizardField: null,
    fallback: "", preview: "#1042" },
  { name: "order_number", label: "Order number (alias)", category: "Order",
    source: "convo.metadata.order_number", wizardField: null,
    fallback: "", preview: "#1042" },
  { name: "order_status", label: "Order status", category: "Order",
    source: "computed.orderStatus", wizardField: null,
    fallback: "Processing", preview: "Shipped" },
  { name: "order_total", label: "Order total", category: "Order",
    source: "computed.orderTotal", wizardField: null,
    fallback: "", preview: "1,499" },
  { name: "order_items", label: "Order items summary", category: "Order",
    source: "computed.orderItems", wizardField: null,
    fallback: "your items", preview: "Smart Doorbell × 1" },
  { name: "tracking_url", label: "Tracking URL", category: "Order",
    source: "computed.trackingUrl", wizardField: null,
    fallback: "", preview: "https://track.example.com/..." },
  { name: "cart_total", label: "Cart total", category: "Order",
    source: "computed.cartTotal", wizardField: null,
    fallback: "", preview: "2,499" },
  { name: "cart_items_count", label: "Cart item count", category: "Order",
    source: "convo.metadata.cart_items_count", wizardField: null,
    fallback: "", preview: "2" },
  { name: "payment_method", label: "Payment method", category: "Order",
    source: "convo.metadata.payment_method", wizardField: null,
    fallback: "", preview: "COD" },

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
  { name: "current_date", label: "Today's date", category: "System",
    source: "computed.currentDate", wizardField: null, fallback: "", preview: "3 May 2026" },
  { name: "current_time", label: "Current time", category: "System",
    source: "computed.currentTime", wizardField: null, fallback: "", preview: "14:32" },
  { name: "discount_code", label: "Discount code", category: "System",
    source: "convo.metadata.discount_code", wizardField: null, fallback: "", preview: "SAVE10" },
  { name: "payment_link", label: "Payment link", category: "System",
    source: "convo.metadata.payment_link", wizardField: null, fallback: "", preview: "https://rzp.io/..." },
];

function resolveSourcePath(path, sources) {
  if (!path || typeof path !== "string") return null;
  const parts = path.split(".").filter(Boolean);
  const root = parts.shift();
  const obj = sources[root];
  if (obj == null) return null;
  return parts.reduce((o, k) => (o != null && o[k] !== undefined ? o[k] : null), obj);
}

module.exports = { VARIABLE_REGISTRY, resolveSourcePath };
