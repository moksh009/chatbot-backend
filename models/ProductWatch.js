const mongoose = require('mongoose');

const productWatchSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', required: true },
  phone: { type: String, required: true, index: true },
  sku: { type: String, required: true, index: true },
  productId: { type: String },
  variantId: { type: String },
  productName: { type: String, required: true },
  productUrl: { type: String, default: '' },
  condition: { type: String, enum: ['back_in_stock', 'price_drop', 'low_stock'], default: 'back_in_stock' },
  status: {
    type: String,
    enum: ['active', 'watching', 'notified', 'expired', 'cancelled'],
    default: 'active',
    index: true,
  },
  watchedAt: { type: Date, default: Date.now },
  notifiedAt: { type: Date, default: null },
  lastStockSeen: { type: Number, default: 0 },
  cancelledReason: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
});

productWatchSchema.index({ clientId: 1, sku: 1, status: 1 });
productWatchSchema.index(
  { phone: 1, sku: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['active', 'watching'] } },
  }
);

module.exports = mongoose.model('ProductWatch', productWatchSchema);
