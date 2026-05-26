'use strict';

const mongoose = require('mongoose');

const SkuMappingSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    internalSku: { type: String, required: true },
    shopify: {
      productId: String,
      variantId: String,
      sku: String,
      locationIds: [String],
    },
    amazon: {
      sellerSku: String,
      asin: String,
      marketplaceId: String,
      fulfillment: { type: String, enum: ['merchant', 'fba', 'mixed'], default: 'merchant' },
    },
    truthSource: {
      type: String,
      enum: ['ledger', 'shopify', 'amazon_fba', 'amazon_combined'],
      default: 'ledger',
    },
    meesho: { type: mongoose.Schema.Types.Mixed, default: null },
    flipkart: { type: mongoose.Schema.Types.Mixed, default: null },
    mappingSource: { type: String, enum: ['auto', 'manual', 'csv_import'], default: 'auto' },
    confidence: { type: Number, default: 0, min: 0, max: 100 },
    verifiedBy: {
      userId: String,
      at: Date,
    },
  },
  { timestamps: true }
);

SkuMappingSchema.index({ clientId: 1, internalSku: 1 }, { unique: true });
SkuMappingSchema.index({ clientId: 1, 'shopify.sku': 1 });
SkuMappingSchema.index({ clientId: 1, 'amazon.sellerSku': 1 });

module.exports = mongoose.model('SkuMapping', SkuMappingSchema);
