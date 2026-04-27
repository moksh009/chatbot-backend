const mongoose = require('mongoose');

const ProcessingLockSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  clientId: { type: String, required: true, index: true },
  // Keep lock short to avoid perceived long "stuck" response windows.
  lockedAt: { type: Date, default: Date.now, expires: 8 } // Auto-delete after 8 seconds
});

// Compound index to ensure uniqueness per customer per client
ProcessingLockSchema.index({ phone: 1, clientId: 1 }, { unique: true });

module.exports = mongoose.Schema.models?.ProcessingLock || mongoose.model('ProcessingLock', ProcessingLockSchema);
