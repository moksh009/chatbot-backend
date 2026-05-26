'use strict';

const mongoose = require('mongoose');

const REASONS = [
  'manual_recount',
  'damaged',
  'received_shipment',
  'theft',
  'sample',
  'correction',
  'reconciliation',
  'return',
  'other',
];

const SOURCES = [
  'manual_dashboard',
  'shopify_webhook',
  'amazon_order',
  'shopify_order',
  'reconciliation',
  'amazon_inventory_pull',
  'purchase_order',
  'return_event',
];

const InventoryAdjustmentSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    sku: { type: String, required: true },
    locationId: { type: String, default: 'default' },
    delta: { type: Number, required: true },
    reason: { type: String, enum: REASONS, default: 'other' },
    reasonNote: { type: String, default: '' },
    idempotencyKey: { type: String, required: true },
    source: { type: String, enum: SOURCES, default: 'manual_dashboard' },
    sourceRef: { type: String, default: '' },
    qtyBefore: { type: Number },
    qtyAfter: { type: Number },
    syncStatus: {
      type: String,
      enum: ['synced', 'pending', 'failed'],
      default: 'synced',
    },
    createdBy: {
      userId: { type: String, default: '' },
      name: { type: String, default: '' },
    },
    audit: {
      ip: { type: String, default: '' },
      userAgent: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

InventoryAdjustmentSchema.index({ clientId: 1, sku: 1, locationId: 1, createdAt: -1 });
InventoryAdjustmentSchema.index({ clientId: 1, idempotencyKey: 1 }, { unique: true });
InventoryAdjustmentSchema.index({ clientId: 1, source: 1, sourceRef: 1 });

module.exports = mongoose.model('InventoryAdjustment', InventoryAdjustmentSchema);
module.exports.INVENTORY_ADJUSTMENT_REASONS = REASONS;
module.exports.INVENTORY_ADJUSTMENT_SOURCES = SOURCES;
