'use strict';

const mongoose = require('mongoose');

const ReturnEventSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    orderId: { type: String, required: true },
    lineItems: [
      {
        sku: String,
        quantity: Number,
        reason: {
          type: String,
          enum: [
            'defective',
            'wrong_item',
            'customer_changed_mind',
            'damaged_in_transit',
            'size_issue',
            'other',
          ],
          default: 'other',
        },
        condition: {
          type: String,
          enum: ['resellable', 'damaged', 'refurbishable', 'unknown'],
          default: 'unknown',
        },
        receivedAt: Date,
        inspectedAt: Date,
        finalState: {
          type: String,
          enum: ['restocked', 'written_off', 'refurbished', null],
          default: null,
        },
      },
    ],
    channel: {
      type: String,
      enum: ['shopify', 'amazon', 'meesho', 'flipkart', 'manual'],
      default: 'manual',
    },
    channelReturnId: { type: String, default: '' },
    status: {
      type: String,
      enum: ['initiated', 'in_transit', 'received', 'inspected', 'closed'],
      default: 'initiated',
    },
    refundAmount: { type: Number, default: 0 },
    refundedAt: Date,
    events: [
      {
        at: { type: Date, default: Date.now },
        type: String,
        actor: { userId: String, name: String },
        notes: String,
        channel: { type: String, enum: ['whatsapp', 'email', 'manual'], default: 'manual' },
      },
    ],
  },
  { timestamps: true }
);

ReturnEventSchema.index({ clientId: 1, status: 1 });
ReturnEventSchema.index({ clientId: 1, orderId: 1 });

module.exports = mongoose.model('ReturnEvent', ReturnEventSchema);
