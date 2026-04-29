const mongoose = require('mongoose');

/**
 * SubmissionQueueItem — Each queued template gets one document.
 * Tracks position within the staged submission queue and batch assignment.
 */
const SubmissionQueueItemSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaTemplate', required: true },
  queuePosition: { type: Number, required: true },
  batchNumber: { type: Number, required: true },
  status: {
    type: String,
    enum: ['queued', 'submitting', 'submitted', 'failed'],
    default: 'queued'
  },
  submittedAt: { type: Date, default: null },
  failureReason: { type: String, default: null },
  retryCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Efficient queries for next-batch lookups and batch tracking
SubmissionQueueItemSchema.index({ clientId: 1, status: 1, queuePosition: 1 });
SubmissionQueueItemSchema.index({ clientId: 1, batchNumber: 1 });

module.exports = mongoose.model('SubmissionQueueItem', SubmissionQueueItemSchema);
