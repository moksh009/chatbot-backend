'use strict';

const mongoose = require('mongoose');

const RestockRuleSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    sku: { type: String, default: null },
    category: { type: String, default: null },
    leadTimeDays: { type: Number, default: 14 },
    safetyStockDays: { type: Number, default: 7 },
    reorderQuantity: { type: Number, default: null },
    minOrderQuantity: { type: Number, default: 1 },
    criticalDays: { type: Number, default: 3 },
    lowDays: { type: Number, default: 7 },
    preferredSupplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
    autoCreateDraft: { type: Boolean, default: false },
    autoNotifySupplier: { type: Boolean, default: false },
  },
  { timestamps: true }
);

RestockRuleSchema.index({ clientId: 1, sku: 1 }, { unique: true, sparse: true });
RestockRuleSchema.index({ clientId: 1, category: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('RestockRule', RestockRuleSchema);
