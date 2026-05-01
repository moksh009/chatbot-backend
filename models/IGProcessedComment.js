const mongoose = require('mongoose');

const IGProcessedCommentSchema = new mongoose.Schema({
  commentId: { type: String, required: true, unique: true },
  automationId: { type: mongoose.Schema.Types.ObjectId, ref: 'IGAutomation' },
  clientId: { type: String, required: true, index: true },
  processedAt: { type: Date, default: Date.now }
});

IGProcessedCommentSchema.index({ commentId: 1 }, { unique: true });
IGProcessedCommentSchema.index({ processedAt: 1 }, { expireAfterSeconds: 86400 }); // TTL 24 hours auto-cleanup

module.exports = mongoose.model('IGProcessedComment', IGProcessedCommentSchema);
