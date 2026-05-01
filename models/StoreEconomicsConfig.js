const mongoose = require('mongoose');

const StoreEconomicsConfigSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true, index: true },
  setupCompleted: { type: Boolean, default: false },
  setupCompletedAt: { type: Date, default: null },
  currentWizardStep: { type: Number, default: 1 },

  // Step 2 — Shipping and Logistics
  codAccepted: { type: Boolean, default: null },
  deliveryCostPerOrder: { type: Number, default: null },
  unacceptedCodLossPerOrder: { type: Number, default: null },
  codRtoRate: { type: Number, default: null },        // stored as decimal e.g. 0.25 for 25%
  totalRtoRate: { type: Number, default: null },       // stored as decimal
  prepaidRtoRate: { type: Number, default: null },     // stored as decimal
  unacceptedOrderLossPerOrder: { type: Number, default: null },

  // Step 3 — Cost Inputs
  cacPerCustomer: { type: Number, default: null },
  gatewayFeeRate: { type: Number, default: null },     // stored as decimal e.g. 0.02 for 2%
  shopifyTransactionFeeRate: { type: Number, default: null }, // stored as decimal
  gstRate: { type: Number, default: null },            // stored as decimal — used separately, NOT in net profit formula
  fixedOverheadsPerOrder: { type: Number, default: null },

  // Step 1 — Packaging mode
  packagingMode: { type: String, enum: ['uniform', 'per_product'], default: null },
  uniformPackagingCost: { type: Number, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('StoreEconomicsConfig', StoreEconomicsConfigSchema);
