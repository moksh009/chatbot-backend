"use strict";

/**
 * Canonical pre-built WhatsApp templates for ecommerce tenants.
 * Names are stable Meta keys; variableMappings use registry names (see variableRegistry.js).
 */
const PREBUILT_TEMPLATE_LIBRARY = [
  {
    key: "order_confirmation_v1",
    metaName: "order_confirmation_v1",
    displayName: "Order confirmation",
    category: "UTILITY",
    headerType: "IMAGE",
    headerVariable: "first_product_image",
    bodyText:
      "Hi {{1}}! 🎉 Your order is confirmed!\n\nOrder ID: {{2}}\nProduct: {{3}}\nTotal: {{4}}\nDelivery to: {{5}}\n\nWe'll notify you when your order ships. Thank you for shopping with us!",
    variableMappings: { body: { 1: "first_name", 2: "order_id", 3: "order_items", 4: "order_total", 5: "shipping_address" } },
    buttons: [{ type: "QUICK_REPLY", text: "Track order" }],
    autoTrigger: "order_placed",
    requiredContext: ["order", "customer", "client"],
  },
  {
    key: "order_shipped_v1",
    metaName: "order_shipped_v1",
    displayName: "Order shipped",
    category: "UTILITY",
    headerType: "TEXT",
    headerText: "Your order is on its way! 🚚",
    bodyText:
      "Hi {{1}}! Great news!\n\nYour order *{{2}}* has been dispatched.\nEstimated delivery: {{3}}\n\nTrack your order using the button below.",
    variableMappings: { body: { 1: "first_name", 2: "order_id", 3: "estimated_delivery" } },
    buttons: [{ type: "URL", text: "Track order", urlVariable: "tracking_url" }],
    autoTrigger: "order_fulfilled",
    requiredContext: ["order", "customer", "client"],
  },
  {
    key: "order_delivered_v1",
    metaName: "order_delivered_v1",
    displayName: "Order delivered",
    category: "MARKETING",
    headerType: "IMAGE",
    headerVariable: "first_product_image",
    bodyText:
      "Hi {{1}}! Your order has been delivered! 📦✅\n\nWe hope you love your *{{2}}*.\n\nHow was your experience? Your feedback helps us improve!",
    variableMappings: { body: { 1: "first_name", 2: "order_items" } },
    autoTrigger: null,
    requiredContext: ["order", "customer", "client"],
  },
  {
    key: "abandoned_cart_r1_v1",
    metaName: "cart_recovery_1",
    displayName: "Abandoned cart — gentle reminder",
    category: "MARKETING",
    headerType: "IMAGE",
    headerVariable: "first_product_image",
    bodyText:
      "Hi {{1}}, you left {{2}} in your cart worth ₹{{3}}. Still interested? Complete your order here 👇",
    variableMappings: {
      body: { 1: "first_name", 2: "product_name", 3: "cart_total" },
      buttons: { 0: "checkout_url" },
    },
    buttons: [{ type: "URL", text: "Complete Order", urlVariable: "checkout_url" }],
    autoTrigger: "abandoned_cart",
    requiredContext: ["cart", "customer", "client"],
  },
  {
    key: "abandoned_cart_r2_v1",
    metaName: "cart_recovery_2",
    displayName: "Abandoned cart — urgency",
    category: "MARKETING",
    headerType: "TEXT",
    headerVariable: null,
    bodyText:
      "Hi {{1}}, your {{2}} is waiting! Many others are viewing it right now 🔥 Tap below before it runs out.",
    variableMappings: {
      body: { 1: "first_name", 2: "product_name" },
      buttons: { 0: "checkout_url" },
    },
    buttons: [{ type: "URL", text: "Grab It Now", urlVariable: "checkout_url" }],
    autoTrigger: "abandoned_cart",
    requiredContext: ["cart", "customer", "client"],
  },
  {
    key: "abandoned_cart_r3_v1",
    metaName: "cart_recovery_3",
    displayName: "Abandoned cart — last chance",
    category: "MARKETING",
    headerType: "IMAGE",
    headerVariable: "first_product_image",
    bodyText:
      "Hi {{1}}, last chance to get {{2}} (₹{{3}})! Here's a special offer — use code {{5}} for 10% off.\n\nTap below to complete your order 👇",
    variableMappings: {
      body: { 1: "first_name", 2: "product_name", 3: "cart_total", 5: "discount_code" },
      buttons: { 0: "checkout_url" },
    },
    buttons: [{ type: "URL", text: "Use Offer Now", urlVariable: "checkout_url" }],
    autoTrigger: "abandoned_cart",
    requiredContext: ["cart", "customer", "client"],
  },
  {
    key: "cod_confirmation_v1",
    metaName: "cod_confirmation_v1",
    displayName: "COD order confirmation",
    category: "UTILITY",
    headerType: "IMAGE",
    headerVariable: "first_product_image",
    bodyText:
      "Hi {{1}}! We received your Cash on Delivery order! 🛍️\n\nOrder: *{{2}}*\nProduct: {{3}}\nAmount due at delivery: *{{4}}*\nDelivering to: {{5}}\n\nPlease confirm to dispatch your order.",
    variableMappings: { body: { 1: "first_name", 2: "order_id", 3: "order_items", 4: "order_total", 5: "shipping_address" } },
    buttons: [
      { type: "QUICK_REPLY", text: "Confirm order" },
      { type: "QUICK_REPLY", text: "Need help" },
    ],
    autoTrigger: "cod_order_placed",
    requiredContext: ["order", "customer", "client"],
  },
  {
    key: "order_cancellation_v1",
    metaName: "order_cancellation_v1",
    displayName: "Cancellation received",
    category: "UTILITY",
    headerType: "NONE",
    bodyText:
      "Hi {{1}},\n\nYour cancellation request for Order *{{2}}* has been received.\n\nIf eligible, your refund of *{{3}}* will be credited within 5–7 business days.\n\nWe hope to see you again at {{4}}!",
    variableMappings: { body: { 1: "first_name", 2: "order_id", 3: "order_total", 4: "brand_name" } },
    autoTrigger: null,
    requiredContext: ["order", "customer", "client"],
  },
  {
    key: "warranty_registration_v1",
    metaName: "warranty_registration_v1",
    displayName: "Warranty activated",
    category: "UTILITY",
    headerType: "NONE",
    bodyText:
      "Hi {{1}}! 🛡️ Your warranty is now active!\n\nProduct: *{{2}}*\nOrder: {{3}}\nPurchase date: {{4}}\nWarranty valid until: *{{5}}*\n\nReply *menu* anytime for help.",
    variableMappings: { body: { 1: "first_name", 2: "order_items", 3: "order_id", 4: "order_date", 5: "warranty_duration" } },
    autoTrigger: "order_placed",
    requiredContext: ["order", "customer", "client"],
  },
  {
    key: "admin_human_alert",
    metaName: "admin_human_alert",
    displayName: "Admin handoff alert",
    category: "UTILITY",
    headerType: "NONE",
    bodyText:
      "Admin alert: {{1}} ({{2}}) needs urgent support. Context: {{3}} Please open the inbox in the dashboard.",
    variableMappings: { body: { 1: "first_name", 2: "phone_number", 3: "issue_summary" } },
    buttons: [{ type: "QUICK_REPLY", text: "Open Inbox" }],
    autoTrigger: null,
    requiredContext: ["customer", "client"],
  },
  {
    key: "product_back_in_stock",
    metaName: "product_back_in_stock",
    displayName: "Product back in stock",
    category: "UTILITY",
    headerType: "NONE",
    bodyText:
      "Hi! Good news — *{{1}}* is back in stock.\n\nShop now: {{2}}",
    variableMappings: { body: { 1: "product_name", 2: "product_url" } },
    autoTrigger: null,
    requiredContext: ["client"],
  },
];

/** Maps legacy auto-worker keys → library entries (aligned with template-catalog.json) */
const LEGACY_KEY_ALIASES = {
  order_confirmed: "order_confirmation_v1",
  order_confirmation_v1: "order_confirmation_v1",
  admin_handoff: "admin_human_alert",
  admin_human_alert: "admin_human_alert",
  cart_recovery_1: "abandoned_cart_r1_v1",
  cart_recovery_2: "abandoned_cart_r2_v1",
  cart_recovery_3: "abandoned_cart_r3_v1",
  abandoned_cart_r1_v1: "abandoned_cart_r1_v1",
  abandoned_cart_r2_v1: "abandoned_cart_r2_v1",
  abandoned_cart_r3_v1: "abandoned_cart_r3_v1",
};

let _catalogAliases = null;
function catalogKeyAliases() {
  if (_catalogAliases) return _catalogAliases;
  try {
    const { getNameAliases } = require("./templateCatalog/catalog");
    _catalogAliases = getNameAliases();
  } catch {
    _catalogAliases = {};
  }
  return _catalogAliases;
}

function getPrebuiltByKey(key) {
  const aliases = catalogKeyAliases();
  const canonical = aliases[key] || key;
  const k = LEGACY_KEY_ALIASES[key] || LEGACY_KEY_ALIASES[canonical] || canonical;
  return PREBUILT_TEMPLATE_LIBRARY.find((t) => t.key === k || t.metaName === k || t.metaName === canonical) || null;
}

module.exports = {
  PREBUILT_TEMPLATE_LIBRARY,
  LEGACY_KEY_ALIASES,
  getPrebuiltByKey,
};
