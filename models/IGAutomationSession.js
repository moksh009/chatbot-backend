const mongoose = require('mongoose');

const IGAutomationSessionSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  automationId: { type: mongoose.Schema.Types.ObjectId, ref: 'IGAutomation', required: true },
  igsid: { type: String, required: true },
  commentId: { type: String },
  stage: {
    type: String,
    enum: ['opening_sent', 'gate_check_1', 'gate_check_2', 'gate_passed', 'gate_failed_terminal', 'link_sent'],
    default: 'opening_sent'
  },
  attemptCount: { type: Number, default: 0 },
  automationName: { type: String, default: '' },
  actionTaken: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) }
});

// Prevent the same user from triggering the same automation twice within 24 hours
IGAutomationSessionSchema.index({ automationId: 1, igsid: 1 }, { unique: true });

// MongoDB TTL auto-cleanup — removes expired sessions automatically
IGAutomationSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('IGAutomationSession', IGAutomationSessionSchema);
