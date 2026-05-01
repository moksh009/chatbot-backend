const mongoose = require('mongoose');

const ProcessingLockSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  clientId: { type: String, required: true, index: true },
  _lockOwnerId: { type: String, required: true }, // UUID for ownership-safe deletion
  // 30s TTL accommodates multi-node flows without premature expiry
  lockedAt: { type: Date, default: Date.now, expires: 30 }
});

// Compound index to ensure uniqueness per customer per client
ProcessingLockSchema.index({ phone: 1, clientId: 1 }, { unique: true });

module.exports = mongoose.Schema.models?.ProcessingLock || mongoose.model('ProcessingLock', ProcessingLockSchema);
