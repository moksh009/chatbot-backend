"use strict";

const mongoose = require("mongoose");

const ShopifyProductSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  shopifyProductId: { type: String, required: true },
  shopifyVariantId: { type: String, required: true },
  sku: { type: String, default: "" },
  title: { type: String, default: "" },
  variantTitle: { type: String, default: "" },
  price: { type: Number, default: 0 },
  currency: { type: String, default: "INR" },
  imageUrl: { type: String, default: "" },
  productUrl: { type: String, default: "" },
  collectionIds: [{ type: String }],
  collectionTitles: [{ type: String }],
  inStock: { type: Boolean, default: true },
  compareAtPrice: { type: Number },
  vendor: { type: String, default: "" },
  productType: { type: String, default: "" },
  tags: [{ type: String }],
  lastSyncedAt: { type: Date }
});

ShopifyProductSchema.index({ clientId: 1, shopifyVariantId: 1 }, { unique: true });
ShopifyProductSchema.index({ clientId: 1, collectionIds: 1 });
ShopifyProductSchema.index({ clientId: 1, inStock: 1 });

module.exports = mongoose.model("ShopifyProduct", ShopifyProductSchema);
