'use strict';

const mongoose = require('mongoose');

/**
 * Dedup ledger for order-status WhatsApp sends.
 *
 * One row per (clientId, shopifyOrderId, statusKey) — prevents the same
 * status template from going out twice for the same order on Shopify retries
 * or repeated `orders/updated` payloads.
 *
 * statusKey is "<type>_<status>" e.g.
 *   financial_status_paid
 *   financial_status_partially_refunded
 *   fulfillment_status_fulfilled
 *   fulfillment_status_unfulfilled
 *
 * Records older than 90 days are dropped automatically (TTL on sentAt).
 * Older Shopify orders almost never receive new status pings, so the row
 * is no longer useful past that window.
 */
const orderStatusSentSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    orderId: { type: String, required: true },
    statusKey: { type: String, required: true },
    ruleId: { type: String, default: '' },
    phone: { type: String, default: '' },
    sentAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
  },
  { collection: 'orderStatusSent', timestamps: false }
);

orderStatusSentSchema.index(
  { clientId: 1, orderId: 1, statusKey: 1 },
  { unique: true, name: 'order_status_sent_unique' }
);

module.exports = mongoose.model('OrderStatusSent', orderStatusSentSchema);
