const mongoose = require('mongoose');

const ReviewRequestSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  phone: String,
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  orderNumber: String,
  productName: String,
  status: { type: String, enum: ['scheduled','sent','responded_positive','responded_negative'], default: 'scheduled' },
  scheduledFor: Date,
  sentAt: Date,
  response: String,
  reviewUrl: String
});

module.exports = mongoose.model('ReviewRequest', ReviewRequestSchema);
