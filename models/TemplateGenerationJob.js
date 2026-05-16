const mongoose = require('mongoose');

/**
 * TemplateGenerationJob — Tracks the entire generation + submission lifecycle per workspace.
 * Exactly one active document per clientId at any time (enforced by unique index).
 */
const TemplateGenerationJobSchema = new mongoose.Schema({
  clientId: { type: String, required: true, unique: true, index: true },
  status: {
    type: String,
    enum: ['idle', 'generating', 'generation_complete', 'drafts_ready', 'submitting', 'paused', 'completed', 'failed'],
    default: 'idle'
  },
  pausedByUser: { type: Boolean, default: false },
  startedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },

  // Counters
  totalTemplates: { type: Number, default: 0 },
  generatedCount: { type: Number, default: 0 },
  submittedCount: { type: Number, default: 0 },
  approvedCount: { type: Number, default: 0 },
  rejectedCount: { type: Number, default: 0 },
  failedGenerationCount: { type: Number, default: 0 },

  // Scheduler state
  nextBatchCheckAt: { type: Date, default: null },
  lastBatchSubmittedAt: { type: Date, default: null },

  // Dismissal state (onboarding modal)
  dismissedAt: { type: Date, default: null },
  autoDismissed: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('TemplateGenerationJob', TemplateGenerationJobSchema);
