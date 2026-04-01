const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
  phone: { type: String, required: true }, // User phone number
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  customerName: { type: String, default: '' }, // WhatsApp profile name or provided name
  status: { 
    type: String, 
    enum: ['BOT_ACTIVE', 'HUMAN_TAKEOVER', 'CLOSED', 'WAITING_FOR_INPUT'], 
    default: 'BOT_ACTIVE' 
  },
  waitingForVariable:   { type: String, default: null },
  captureResumeNodeId:  { type: String, default: null },
  capturedData:         { type: mongoose.Schema.Types.Mixed, default: {} },

  assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Agent ID
  unreadCount: { type: Number, default: 0 },
  lastMessage: { type: String },
  lastMessageAt: { type: Date, default: Date.now },
  
  // Smart User Memory Summary
  summary: { type: String, default: '' },
  lastAppointment: { type: Date },
  appointmentStatus: { type: String }, // e.g., 'Booked', 'Completed', 'Cancelled'
  
  tags: [{ type: String }], // e.g., 'Lead', 'Complaint', 'VIP'
  lastStepId: { type: String, default: null }, // For ReactFlow graph traversal state
  
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
  resolvedAt: { type: Date },
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

  // Phase 13 Omnichannel
  channel: {
    type: String,
    enum: ["whatsapp", "instagram", "email"],
    default: "whatsapp"
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Compound index for unique conversation per phone + client
ConversationSchema.index({ phone: 1, clientId: 1 }, { unique: true });

// Pre-save hook to cap processedMessageIds
ConversationSchema.pre('save', function(next) {
  if (this.processedMessageIds.length > 50) {
    this.processedMessageIds = this.processedMessageIds.slice(-50);
  }
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Conversation', ConversationSchema);
