'use strict';

const mongoose = require('mongoose');

const InventoryLedgerSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    sku: { type: String, required: true },
    locationId: { type: String, default: 'default' },
    available: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
    onOrder: { type: Number, default: 0 },
    backorder: { type: Number, default: 0 },
    lastShopifySync: {
      at: { type: Date },
      qty: { type: Number },
    },
    lastAmazonSync: {
      at: { type: Date },
      qty: { type: Number },
      fbaFulfillable: { type: Number },
      merchantFulfilled: { type: Number },
    },
    lastReconciliation: {
      at: { type: Date },
      drift: { type: Number },
      action: { type: String },
    },
    lastAdjustmentAt: { type: Date },
    lastAdjustmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryAdjustment' },
  },
  { timestamps: true }
);

InventoryLedgerSchema.index({ clientId: 1, sku: 1, locationId: 1 }, { unique: true });

module.exports = mongoose.model('InventoryLedger', InventoryLedgerSchema);
