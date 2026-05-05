const mongoose = require('mongoose');

const SuppressionSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  clientId: { type: String, required: true, index: true },
  reason: { type: String, enum: ['opted_out', 'bounced', 'spam_report', 'legal', 'admin'], default: 'opted_out' },
  addedAt: { type: Date, default: Date.now },
  source: { type: String, default: '' },
  notes: { type: String, default: '' },
});

SuppressionSchema.index({ phone: 1, clientId: 1 }, { unique: true });

module.exports = mongoose.model('SuppressionList', SuppressionSchema);
