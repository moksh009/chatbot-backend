const mongoose = require('mongoose');

const CampaignSchema = new mongoose.Schema({
  name: { type: String, required: true },
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  templateName: { type: String, default: "" },
  status: { 
    type: String, 
    enum: ['DRAFT', 'SCHEDULED', 'QUEUED', 'SENDING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'], 
    default: 'DRAFT' 
  },
  audienceMode: { type: String, enum: ['snapshot', 'live'], default: 'snapshot' },
  audienceRefreshable: { type: Boolean, default: false },
  audienceRefreshHoursMax: { type: Number, default: 24 },
  lastAudienceRefreshAt: { type: Date, default: null },
  stats: {
    queued: { type: Number, default: 0 },
    processing: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    cancelled: { type: Number, default: 0 },
    lastProgressAt: { type: Date, default: null },
  },
  scheduledAt: { type: Date },
  csvFile: { type: String }, // Path to uploaded CSV
  segmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Segment' },
  importBatchId: { type: String }, // ID from ImportSession

  audience: { type: Array, default: [] }, // Array of resolved phone numbers + mappings
  variableMapping: { type: mongoose.Schema.Types.Mixed },
  customTextValues: { type: mongoose.Schema.Types.Mixed, default: {} },
  templateComponents: { type: Array, default: [] },
  languageCode: { type: String, default: 'en' },
  // Phase 22: Smart Send logic
  isSmartSend: { type: Boolean, default: false },
  smartSendConfig: { type: mongoose.Schema.Types.Mixed },

  /** Phase 9: fixed broadcast time vs per-contact optimal hour */
  scheduleStrategy: {
    type: String,
    enum: ['fixed', 'per_contact_optimal'],
    default: 'fixed',
  },
  // Phase 28: Predictive Send (AI-timed delivery)
  isPredictiveSend: { type: Boolean, default: false },
  predictiveSendConfig: {
    enabled: { type: Boolean, default: false },
    windowHours: { type: Number, default: 24 }, // max delay window
    fallbackImmediate: { type: Boolean, default: true } // send now if no data
  },

  recipientCount:  { type: Number, default: 0 },
  sentCount:       { type: Number, default: 0 },
  deliveredCount:  { type: Number, default: 0 },
  readCount:       { type: Number, default: 0 },
  repliedCount:    { type: Number, default: 0 },
  failedCount:     { type: Number, default: 0 },
  processingCount: { type: Number, default: 0 },
  queuedCount:     { type: Number, default: 0 },
  websiteClicks:   { type: Number, default: 0 },
  buttonClicks:    { type: Number, default: 0 },
  revenueAttributed: { type: Number, default: 0 },
  
  channel:         { type: String, enum: ['whatsapp', 'sms', 'email'], default: 'whatsapp' },
  emailSubject:    { type: String, default: '' },
  emailHtml:       { type: String, default: '' },
  campaignType:    { type: String, enum: ["STANDARD", "RE_PERMISSION"], default: "STANDARD" },
  templateCategory:{ type: String, default: "MARKETING" }, // UTILITY | MARKETING | AUTHENTICATION
  marketingOptInExcludedCount: { type: Number, default: 0 },
  autoPaused:      { type: Boolean, default: false },
  autoPausedReason:{ type: String, default: "" },

  attributedOrders: { type: Number, default: 0 },
  isAbTest: { type: Boolean, default: false },
  abTestConfig: {
    testSizePercentage: { type: Number, default: 20 }, // 20% sent initially, 80% holdback
    winnerMetric: { type: String, enum: ['read_rate', 'reply_rate', 'revenue'], default: 'reply_rate' },
    holdbackHours: { type: Number, default: 4 }, // Hours to wait before deciding winner
    autoSendWinner: { type: Boolean, default: true },
    holdbackProcessed: { type: Boolean, default: false }
  },
  abVariants: [{
    label: String, // e.g., "A" or "B"
    templateName: String,
    languageCode: { type: String, default: 'en' },
    recipientCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    deliveredCount: { type: Number, default: 0 },
    readCount: { type: Number, default: 0 },
    repliedCount: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 }
  }],
  winnerVariant: String,

  createdAt: { type: Date, default: Date.now }
});

CampaignSchema.index({ clientId: 1, createdAt: -1 });

const { enforceClientScope } = require('../mongoose/plugins/enforceClientScope');
CampaignSchema.plugin(enforceClientScope);

module.exports = mongoose.model('Campaign', CampaignSchema);
