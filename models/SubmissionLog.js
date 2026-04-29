const mongoose = require('mongoose');

/**
 * SubmissionLog — Immutable audit trail.
 * One document per submission attempt. Never deleted, never updated.
 */
const SubmissionLogSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetaTemplate' },
  templateName: { type: String },
  action: {
    type: String,
    enum: ['submitted', 'approved', 'rejected', 'polling_check', 'rate_limited', 'failed'],
    required: true
  },
  metaResponse: { type: mongoose.Schema.Types.Mixed },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('SubmissionLog', SubmissionLogSchema);
