"use strict";

const mongoose = require("mongoose");

const ShopifyCollectionSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  shopifyCollectionId: { type: String, required: true },
  title: { type: String, default: "" },
  handle: { type: String, default: "" },
  description: { type: String, default: "" },
  imageUrl: { type: String, default: "" },
  productsCount: { type: Number, default: 0 },
  collectionType: { type: String, enum: ["custom", "smart"], default: "custom" },
  whatsappMenuLabel: { type: String, default: "" },
  whatsappEnabled: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
  lastSyncedAt: { type: Date }
});

ShopifyCollectionSchema.index({ clientId: 1, shopifyCollectionId: 1 }, { unique: true });

module.exports = mongoose.model("ShopifyCollection", ShopifyCollectionSchema);
