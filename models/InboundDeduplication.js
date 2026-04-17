const mongoose = require('mongoose');

const InboundDeduplicationSchema = new mongoose.Schema({
  messageId: { type: String, required: true },
  clientId: { type: String, required: true },
  phone: { type: String, required: true },
  processedAt: { type: Date, default: Date.now, expires: 120 } // Auto-delete after 2 minutes
});

// Ensure uniqueness per messageId to prevent dual-processing
InboundDeduplicationSchema.index({ messageId: 1 }, { unique: true });

module.exports = mongoose.models.InboundDeduplication || mongoose.model('InboundDeduplication', InboundDeduplicationSchema);
