'use strict';

const mongoose = require('mongoose');

const InventoryLocationSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    locationId: { type: String, required: true },
    name: { type: String, required: true },
    type: {
      type: String,
      enum: ['warehouse', 'store', 'fba_pool', 'dropship', 'virtual'],
      default: 'warehouse',
    },
    address: { type: mongoose.Schema.Types.Mixed, default: {} },
    isDefault: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    shopifyLocationId: { type: String, default: null },
    amazonMarketplaceIds: [{ type: String }],
  },
  { timestamps: true }
);

InventoryLocationSchema.index({ clientId: 1, locationId: 1 }, { unique: true });
InventoryLocationSchema.index({ clientId: 1, isDefault: 1 }, { sparse: true });

module.exports = mongoose.model('InventoryLocation', InventoryLocationSchema);
