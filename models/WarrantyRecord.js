const mongoose = require('mongoose');

const warrantyRecordSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Contact',
    required: true
  },
  shopifyOrderId: {
    type: String,
    required: true
  },
  productId: {
    type: String,
    required: true
  },
  productName: {
    type: String,
    required: true
  },
  purchaseDate: {
    type: Date,
    default: Date.now
  },
  expiryDate: {
    type: Date,
    required: true
  },
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WarrantyBatch',
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'terminated', 'void'],
    default: 'active'
  }
}, {
  timestamps: true
});

// Optimized indexes for enterprise scale and dashboard performance
warrantyRecordSchema.index({ clientId: 1, shopifyOrderId: 1 });
warrantyRecordSchema.index({ clientId: 1, status: 1 });
warrantyRecordSchema.index({ customerId: 1 });
warrantyRecordSchema.index({ batchId: 1 });
warrantyRecordSchema.index({ expiryDate: 1 });

const WarrantyRecord = mongoose.model('WarrantyRecord', warrantyRecordSchema);

module.exports = WarrantyRecord;
