const mongoose = require('mongoose');

const ProcessingLockSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  clientId: { type: String, required: true, index: true },
  lockedAt: { type: Date, default: Date.now, expires: 30 } // Auto-delete after 30 seconds
});

// Compound index to ensure uniqueness per customer per client
ProcessingLockSchema.index({ phone: 1, clientId: 1 }, { unique: true });

module.exports = mongoose.Schema.models?.ProcessingLock || mongoose.model('ProcessingLock', ProcessingLockSchema);
