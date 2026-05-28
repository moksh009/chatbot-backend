const mongoose = require('mongoose');

const DEDUP_RETENTION_SEC = Number(process.env.WEBHOOK_DEDUP_RETENTION_SEC || 7 * 24 * 60 * 60); // 7 days

const InboundDeduplicationSchema = new mongoose.Schema({
  messageId: { type: String, required: true },
  clientId: { type: String, required: true },
  phone: { type: String, required: true },
  processedAt: { type: Date, default: Date.now }
});

InboundDeduplicationSchema.index({ messageId: 1, clientId: 1 }, { unique: true });
InboundDeduplicationSchema.index({ processedAt: 1 }, { expireAfterSeconds: DEDUP_RETENTION_SEC });

module.exports = mongoose.models.InboundDeduplication || mongoose.model('InboundDeduplication', InboundDeduplicationSchema);
