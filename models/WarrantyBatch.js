const mongoose = require('mongoose');

const warrantyBatchSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  batchName: {
    type: String,
    required: true,
    trim: true
  },
  shopifyProductIds: [{
    type: String // or Number if preferred, but Shopify IDs are often handled as strings in JS
  }],
  durationMonths: {
    type: Number,
    required: true,
    default: 12
  },
  validFrom: {
    type: Date,
    default: Date.now
  },
  validUntil: {
    type: Date
  },
  status: {
    type: String,
    enum: ['active', 'terminated'],
    default: 'active'
  }
}, {
  timestamps: true
});

// Index for high-performance lookup in webhooks
warrantyBatchSchema.index({ clientId: 1, shopifyProductIds: 1, status: 1 });
warrantyBatchSchema.index({ validFrom: 1, validUntil: 1 });

const WarrantyBatch = mongoose.model('WarrantyBatch', warrantyBatchSchema);

module.exports = WarrantyBatch;
