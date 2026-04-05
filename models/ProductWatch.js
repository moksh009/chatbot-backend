const mongoose = require('mongoose');

const productWatchSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  leadId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdLead', required: true },
  phone: { type: String, required: true },
  productId: { type: String, required: true },
  variantId: { type: String, required: true },
  productName: { type: String, required: true },
  condition: { type: String, enum: ['back_in_stock', 'price_drop', 'low_stock'], default: 'back_in_stock' },
  status: { type: String, enum: ['watching', 'notified'], default: 'watching' },
  notifiedAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('ProductWatch', productWatchSchema);
