'use strict';

const mongoose = require('mongoose');

const BundleDefinitionSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    bundleSku: { type: String, required: true },
    components: [
      {
        componentSku: { type: String, required: true },
        quantity: { type: Number, default: 1, min: 1 },
      },
    ],
    isVirtual: { type: Boolean, default: true },
  },
  { timestamps: true }
);

BundleDefinitionSchema.index({ clientId: 1, bundleSku: 1 }, { unique: true });

module.exports = mongoose.model('BundleDefinition', BundleDefinitionSchema);
