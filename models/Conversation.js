const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
  phone: { type: String, required: true }, // User phone number
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  customerName: { type: String, default: '' }, // WhatsApp profile name or provided name
  status: { 
    type: String, 
    enum: ['BOT_ACTIVE', 'HUMAN_TAKEOVER', 'HUMAN_SUPPORT', 'CLOSED', 'WAITING_FOR_INPUT', 'OPTED_OUT', 'new', 'PAUSED'], 
    default: 'BOT_ACTIVE' 
  },
  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Agent ID
  assignedAt:  { type: Date, default: null },
  assignedBy:  { type: String, default: null }, // User name who assigned
  unreadCount: { type: Number, default: 0 },
  lastMessage: { type: String },
  lastMessageAt: { type: Date, default: Date.now },
  
  // Smart User Memory Summary
  summary: { type: String, default: '' },
  lastAppointment: { type: Date },
  appointmentStatus: { type: String }, // e.g., 'Booked', 'Completed', 'Cancelled'
  
  tags: [{ type: String }],    // e.g., 'Lead', 'Complaint', 'VIP'
  labels: [{ type: String }],  // Phase 21: Team inbox labels e.g. 'billing', 'support'
  internalNotes: [{
    content:   String,
    authorId:  mongoose.Schema.Types.ObjectId,
    authorName:String,
    createdAt: { type: Date, default: Date.now }
  }],
  lastStepId: { type: String, default: null }, // For ReactFlow graph traversal state
  isBotPaused: { type: Boolean, default: false }, // Alias for UI compatibility
  
  // Phase 9 fields
  botPaused:         { type: Boolean, default: false },
  requiresAttention: { type: Boolean, default: false },
  attentionReason:   { type: String,  default: '' },
  currentContext:    { type: String,  default: null },
  lastInteraction:   { type: Date,    default: Date.now },

  // Phase 11 Fields
  csatScore: { rating: Number, respondedAt: Date },
  csatSent: { type: Boolean, default: false },
  priority: { type: String, enum: ["normal","high","vip"], default: "normal" },
  // Phase 23: Enterprise Metrics
  firstInboundAt:  { type: Date },
  firstResponseAt: { type: Date },
  resolvedAt:      { type: Date },

  afterHours: { type: Boolean, default: false },

  metadata: { type: Object, default: {} },
  
  // Phase 17 Enterprise Robustness
  processedMessageIds: { 
    type: [String], 
    default: [],
    index: true // index for deduplication search
  },
  consecutiveFailedMessages: { type: Number, default: 0 },
  lastNodeVisited: {
    nodeId:   String,
    nodeType: String,
    nodeLabel:String,
    visitedAt:Date
  },
  flowPausedUntil: { type: Date },
  pausedAtNodeId:  { type: String },
  abVariant:       { type: String },

  // Phase 18: Capture Node State
  waitingForVariable:   { type: String,  default: null }, // variable name being captured
  captureResumeNodeId:  { type: String,  default: null }, // node to resume after capture
  captureRetries:       { type: Number,  default: 0 },    // current retry count

  // Phase 13 Omnichannel
  channel: {
    type: String,
    enum: ["whatsapp", "instagram", "email"],
    default: "whatsapp"
  },

  // Phase 20: Active Flow Tracking
  activeFlowId: { type: String, default: null }, // Which visualFlow is currently running

  // Phase 23: Track 6 - AI Intelligence
  sentiment: { 
    type: String, 
    enum: ['Positive', 'Neutral', 'Negative', 'Frustrated', 'Urgent', 'Unknown'], 
    default: 'Neutral' 
  },
  sentimentScore: { type: Number, default: 0 },
  lastSummaryUpdate: { type: Date },

  // Phase 23: Track 7 - Multi-Language
  detectedLanguage: { type: String, default: 'en' },

  // Phase 29: AI Quality Scorer
  aiQualityScore: { type: Number, default: 0 }, // 0-100
  aiAuditFeedback: { type: String, default: "" },
  lastAuditedAt: { type: Date },

  // Module 2: Intent Engine Live Context
  lastDetectedIntent: {
    intentName:      { type: String, default: null },
    confidenceScore: { type: Number, default: 0 },
    detectedAt:      { type: Date,   default: null }
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});


// Compound index for unique conversation per phone + client
ConversationSchema.index({ phone: 1, clientId: 1 }, { unique: true });

// ✅ Phase R3: Performance indexes — were missing, causing full-collection scans on Live Chat inbox load
ConversationSchema.index({ clientId: 1, lastInteraction: -1 }); // Inbox sort by most recent
ConversationSchema.index({ clientId: 1, status: 1 });            // Status filter (BOT_ACTIVE, HUMAN_TAKEOVER etc.)
ConversationSchema.index({ clientId: 1, requiresAttention: 1 }); // Attention queue in Live Chat
ConversationSchema.index({ clientId: 1, assignedAgent: 1 });     // Agent workload filter
ConversationSchema.index({ clientId: 1, botPaused: 1 });         // Bot-paused conversations filter

// Pre-save hook to cap processedMessageIds
ConversationSchema.pre('save', function(next) {
  if (this.processedMessageIds.length > 50) {
    this.processedMessageIds = this.processedMessageIds.slice(-50);
  }
  this.updatedAt = new Date();
  next();
});

// Performance indexes for dashboard queries
ConversationSchema.index({ clientId: 1, lastMessageAt: -1 });
ConversationSchema.index({ clientId: 1, unreadCount: 1 });
ConversationSchema.index({ clientId: 1, phone: 1 });

module.exports = mongoose.model('Conversation', ConversationSchema);
