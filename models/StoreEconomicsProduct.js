const mongoose = require('mongoose');

const StoreEconomicsProductSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  shopifyProductId: { type: String, required: true },
  productName: { type: String, required: true },
  productImageUrl: { type: String, default: null },
  sellingPrice: { type: Number, required: true },
  cogs: { type: Number, default: null },
  packagingCost: { type: Number, default: null }, // per-product value OR copied from uniform on calculation

  // Server-calculated — recalculated on every wizard completion or edit
  grossMargin: { type: Number, default: null },       // sellingPrice - cogs
  netProfit: { type: Number, default: null },          // full formula result
  netProfitMarginRate: { type: Number, default: null }, // netProfit / sellingPrice

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

StoreEconomicsProductSchema.index({ clientId: 1, shopifyProductId: 1 }, { unique: true });

module.exports = mongoose.model('StoreEconomicsProduct', StoreEconomicsProductSchema);
