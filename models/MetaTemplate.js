const mongoose = require('mongoose');

/**
 * MetaTemplate — Stores auto-generated WhatsApp message templates.
 * Separate from Client.syncedMetaTemplates (which stores Meta-synced raw JSON).
 * Tracks the full lifecycle: draft → queued → submitting → pending_meta_review → approved/rejected.
 */
const ButtonFormSchema = new mongoose.Schema(
  {
    buttonType: { type: String, enum: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'] },
    text: { type: String },
    url: { type: String, default: null },
    urlType: { type: String, enum: ['Static', 'Dynamic'], default: 'Static' },
    sampleUrl: { type: String, default: null },
    phoneNumber: { type: String, default: null },
  },
  { _id: false }
);

const FormDataSchema = new mongoose.Schema(
  {
    variableType: { type: String, enum: ['Name', 'Number'], default: 'Number' },
    mediaSample: { type: String, enum: ['None', 'Image'], default: 'None' },
    headerImageUrl: { type: String, default: null },
    headerText: { type: String, default: null },
    bodyText: { type: String, default: null },
    footerText: { type: String, default: null },
    headerSamples: [{ type: String }],
    bodySamples: [{ type: String }],
    buttons: { type: [ButtonFormSchema], default: [] },
  },
  { _id: false }
);

const MetaTemplateSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  category: { type: String, enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'], required: true, default: 'MARKETING' },
  language: { type: String, default: 'en' },

  usageTags: {
    type: [{ type: String, enum: ['Campaign', 'Sequence', 'Flow Builder', 'Utility'] }],
    default: [],
  },

  formData: { type: FormDataSchema, default: () => ({}) },

  // Template content (legacy + denormalized for workers / list)
  headerType: { type: String, enum: ['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'NONE'], default: 'TEXT' },
  headerValue: { type: String, default: '' },
  body: { type: String, required: true },
  footerText: { type: String, default: null },
  buttons: { type: [mongoose.Schema.Types.Mixed], default: [] },

  // Source tracking
  source: { type: String, enum: ['manual', 'auto_generated', 'wizard_automation', 'wizard_product', 'migrated_legacy'], default: 'manual' },
  autoGenProductId: { type: String, default: null },
  templateKey: { type: String, default: '' }, // canonical template key (ex: order_confirmed)
  templateKind: { type: String, enum: ['prebuilt', 'product', 'custom'], default: 'custom' },
  readinessRequired: { type: Boolean, default: false },
  productHandle: { type: String, default: '' },
  productName: { type: String, default: '' },
  productPrice: { type: String, default: '' },
  productPageUrl: { type: String, default: '' },
  productImageUrl: { type: String, default: '' },
  // Eligibility tags (hybrid): one primary purpose + optional secondary contexts.
  primaryPurpose: {
    type: String,
    enum: ['campaign', 'sequence', 'flow', 'ig', 'utility'],
    default: 'utility'
  },
  secondaryPurposes: {
    type: [String],
    enum: ['campaign', 'sequence', 'flow', 'ig', 'utility'],
    default: []
  },

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
      'flagged',
      'submission_failed',
      'generation_failed'
    ],
    default: 'draft'
  },
  metaApiError: { type: String, default: null },
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
MetaTemplateSchema.index({ clientId: 1, templateKey: 1 });
MetaTemplateSchema.index({ clientId: 1, templateKind: 1, readinessRequired: 1 });
MetaTemplateSchema.index({ clientId: 1, primaryPurpose: 1 });
MetaTemplateSchema.index({ clientId: 1, category: 1 });
MetaTemplateSchema.index({ clientId: 1, name: 1 });

module.exports = mongoose.model('MetaTemplate', MetaTemplateSchema);
