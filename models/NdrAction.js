'use strict';

const mongoose = require('mongoose');

const NdrActionSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    orderMongoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true },
    shopifyOrderId: { type: String, default: '' },
    awb: { type: String, default: '' },
    action: {
      type: String,
      enum: ['reattempt', 'phone_update', 'address_update', 'manual_pending'],
      default: 'reattempt',
    },
    customerPhone: { type: String, default: '' },
    capturedPhone: { type: String, default: '' },
    capturedAddress: { type: String, default: '' },
    capturedPincode: { type: String, default: '' },
    shiprocketResponse: { type: mongoose.Schema.Types.Mixed, default: null },
    status: {
      type: String,
      enum: ['pending', 'success', 'failed', 'manual'],
      default: 'pending',
    },
    errorMessage: { type: String, default: '' },
  },
  { timestamps: true }
);

NdrActionSchema.index({ clientId: 1, createdAt: -1 });

module.exports = mongoose.model('NdrAction', NdrActionSchema);
