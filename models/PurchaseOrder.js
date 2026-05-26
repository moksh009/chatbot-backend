'use strict';

const mongoose = require('mongoose');

const LineItemSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true },
    productName: { type: String, default: '' },
    quantity: { type: Number, required: true },
    unitCost: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    receivedQuantity: { type: Number, default: 0 },
    receivedAt: { type: Date, default: null },
    productId: { type: String },
    productTitle: { type: String },
  },
  { _id: false }
);

const POEventSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    type: {
      type: String,
      enum: ['created', 'sent', 'reminded', 'confirmed', 'received', 'cancelled'],
    },
    actor: { userId: String, name: String },
    notes: String,
    channel: { type: String, enum: ['whatsapp', 'email', 'manual'], default: 'manual' },
  },
  { _id: false }
);

const PurchaseOrderSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    poNumber: { type: String, required: true },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    status: {
      type: String,
      enum: [
        'draft',
        'pending_approval',
        'sent',
        'confirmed',
        'partially_received',
        'received',
        'cancelled',
        'delivered',
      ],
      default: 'draft',
    },
    lineItems: [LineItemSchema],
    items: [LineItemSchema],
    subtotal: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    totalCost: { type: Number },
    currency: { type: String, default: 'INR' },
    expectedDeliveryDate: Date,
    actualDeliveryDate: Date,
    events: [POEventSchema],
    generatedBy: {
      type: String,
      enum: ['auto_rule', 'manual_merchant', 'smart_suggestion'],
      default: 'manual_merchant',
    },
    sentAt: Date,
    confirmedAt: Date,
    deliveredAt: Date,
    notes: String,
  },
  { timestamps: true }
);

PurchaseOrderSchema.index({ clientId: 1, status: 1 });
PurchaseOrderSchema.index({ clientId: 1, supplierId: 1 });
PurchaseOrderSchema.index({ clientId: 1, poNumber: 1 }, { unique: true });

module.exports = mongoose.model('PurchaseOrder', PurchaseOrderSchema);
