const mongoose = require('mongoose');

const InboundDeduplicationSchema = new mongoose.Schema({
  messageId: { type: String, required: true },
  clientId: { type: String, required: true },
  phone: { type: String, required: true },
  processedAt: { type: Date, default: Date.now, expires: 120 } // Auto-delete after 2 minutes
});

InboundDeduplicationSchema.index({ messageId: 1, clientId: 1 }, { unique: true });
InboundDeduplicationSchema.index({ processedAt: 1 }, { expireAfterSeconds: 7200 });

module.exports = mongoose.models.InboundDeduplication || mongoose.model('InboundDeduplication', InboundDeduplicationSchema);
