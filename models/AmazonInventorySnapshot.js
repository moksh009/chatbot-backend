'use strict';

const mongoose = require('mongoose');

const AmazonInventorySnapshotSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    sellerSku: { type: String, required: true },
    asin: { type: String, default: '' },
    marketplaceId: { type: String, default: 'A21TJ7DG3Y56XX' },
    fba: {
      fulfillable: { type: Number, default: 0 },
      inbound: {
        working: { type: Number, default: 0 },
        shipped: { type: Number, default: 0 },
        receiving: { type: Number, default: 0 },
      },
      reserved: { type: Number, default: 0 },
      unfulfillable: { type: Number, default: 0 },
      researching: { type: Number, default: 0 },
      totalQuantity: { type: Number, default: 0 },
    },
    merchantFulfilled: {
      quantity: { type: Number, default: null },
      lastSyncedAt: { type: Date },
      fulfillmentChannels: [{ type: String }],
    },
    totalSellable: { type: Number, default: 0 },
    lastSyncedAt: { type: Date, default: Date.now },
    lastSyncSource: {
      type: String,
      enum: ['cron', 'manual_refresh', 'webhook'],
      default: 'cron',
    },
    lastSyncError: { type: String, default: '' },
  },
  { timestamps: true }
);

AmazonInventorySnapshotSchema.index({ clientId: 1, sellerSku: 1, marketplaceId: 1 }, { unique: true });
AmazonInventorySnapshotSchema.index({ clientId: 1, lastSyncedAt: -1 });

module.exports = mongoose.model('AmazonInventorySnapshot', AmazonInventorySnapshotSchema);
