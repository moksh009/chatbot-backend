'use strict';

const mongoose = require('mongoose');

/**
 * Dedup ledger for order-status sends (WhatsApp + email per channel).
 *
 * One row per (clientId, shopifyOrderId, statusKey, channel) — prevents the same
 * status notification from going out twice on Shopify retries.
 *
 * Legacy rows without `channel` are treated as WhatsApp in read paths.
 */
const orderStatusSentSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    orderId: { type: String, required: true },
    statusKey: { type: String, required: true },
    channel: { type: String, enum: ['whatsapp', 'email'], default: 'whatsapp' },
    ruleId: { type: String, default: '' },
    phone: { type: String, default: '' },
    email: { type: String, default: '' },
    sentAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 },
  },
  { collection: 'orderStatusSent', timestamps: false }
);

orderStatusSentSchema.index(
  { clientId: 1, orderId: 1, statusKey: 1, channel: 1 },
  { unique: true, name: 'order_status_sent_channel_unique' }
);

module.exports = mongoose.model('OrderStatusSent', orderStatusSentSchema);
