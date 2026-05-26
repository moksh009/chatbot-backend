'use strict';

const mongoose = require('mongoose');

const BackorderRuleSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    sku: { type: String, required: true },
    allowBackorder: { type: Boolean, default: false },
    maxBackorderQty: { type: Number, default: null },
    expectedRestockDate: { type: Date, default: null },
    messaging: {
      cart: { type: String, default: '' },
      checkout: { type: String, default: '' },
      order: { type: String, default: '' },
    },
    autoMessage: { type: Boolean, default: true },
  },
  { timestamps: true }
);

BackorderRuleSchema.index({ clientId: 1, sku: 1 }, { unique: true });

module.exports = mongoose.model('BackorderRule', BackorderRuleSchema);
