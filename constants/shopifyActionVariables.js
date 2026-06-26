'use strict';

/**
 * Shopify Action node — node-local variables (Fetch Latest Order).
 */

const SHOPIFY_ACTION_CATEGORY = 'Shopify Action';

const SHOPIFY_ACTION_VARIABLES = [
  { name: 'order_id', label: 'Order ID', description: 'Order name / unique identifier', preview: '#1042', shopifyActionOnly: true, locked: true },
  { name: 'order_date', label: 'Order date', description: 'Creation date of the order', preview: '12 May 2026', shopifyActionOnly: true, locked: true },
  { name: 'ordered_items', label: 'Ordered items', description: 'Line items — "2x Product Name" per line', preview: '2x Smart Doorbell', shopifyActionOnly: true, locked: true },
  { name: 'order_total', label: 'Order total', description: 'Total price with currency code', preview: '1999.00 INR', shopifyActionOnly: true, locked: true },
  { name: 'shipping_address', label: 'Shipping address', description: 'Full delivery address', preview: '123 MG Road, Mumbai', shopifyActionOnly: true, locked: true },
  { name: 'payment_status', label: 'Payment status', description: 'Financial status (PAID, PENDING...)', preview: 'PAID', shopifyActionOnly: true, locked: true },
  { name: 'fulfillment_status', label: 'Fulfillment status', description: 'Fulfillment lifecycle status', preview: 'FULFILLED', shopifyActionOnly: true, locked: true },
  { name: 'delivery_status', label: 'Delivery status', description: 'Tracking event from carrier', preview: 'In transit', shopifyActionOnly: true, locked: true },
  { name: 'tracking_link', label: 'Tracking link', description: "Order's tracking link", preview: 'https://track.example.com/...', shopifyActionOnly: true, locked: true },
];

const SHOPIFY_ACTION_VARIABLE_NAMES = new Set(SHOPIFY_ACTION_VARIABLES.map((v) => v.name));

const REMOVED_LEGACY_GLOBAL_VARIABLES = new Set([
  'cart_total',
  'cart_items',
  'checkout_url',
  'order_id',
  'order_number',
  'order_status',
  'tracking_url',
]);

module.exports = {
  SHOPIFY_ACTION_CATEGORY,
  SHOPIFY_ACTION_VARIABLES,
  SHOPIFY_ACTION_VARIABLE_NAMES,
  REMOVED_LEGACY_GLOBAL_VARIABLES,
};
