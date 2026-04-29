const mongoose = require('mongoose');

/**
 * MetaTemplate — Stores auto-generated WhatsApp message templates.
 * Separate from Client.syncedMetaTemplates (which stores Meta-synced raw JSON).
 * Tracks the full lifecycle: draft → queued → submitting → pending_meta_review → approved/rejected.
 */
const MetaTemplateSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  category: { type: String, enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'], default: 'MARKETING' },
  language: { type: String, default: 'en' },

  // Template content
  headerType: { type: String, enum: ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'NONE'], default: 'TEXT' },
  headerValue: { type: String, default: '' },
  body: { type: String, required: true },
  footerText: { type: String, default: null },
  buttons: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Source tracking
  source: { type: String, enum: ['manual', 'auto_generated'], default: 'manual' },
  autoGenProductId: { type: String, default: null },

  // Meta submission tracking
  metaTemplateId: { type: String, default: null },
  submissionStatus: {
    type: String,
    enum: [
      'draft',
      'queued',
      'submitting',
      'pending_meta_review',
      'approved',
      'rejected',
      'submission_failed',
      'generation_failed'
    ],
    default: 'draft'
  },
  rejectionReason: { type: String, default: null },
  queuePosition: { type: Number, default: null },
  variableMapping: { type: Map, of: String, default: {} },

  // Timestamps
  submittedAt: { type: Date, default: null },
  approvedAt: { type: Date, default: null },
  rejectedAt: { type: Date, default: null },
  lastPolledAt: { type: Date, default: null },
  metaRetryCount: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Compound indexes for efficient queries
MetaTemplateSchema.index({ clientId: 1, submissionStatus: 1 });
MetaTemplateSchema.index({ clientId: 1, source: 1, submissionStatus: 1 });
MetaTemplateSchema.index({ clientId: 1, autoGenProductId: 1 });

module.exports = mongoose.model('MetaTemplate', MetaTemplateSchema);
