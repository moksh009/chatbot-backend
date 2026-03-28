const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
  phone: { type: String, required: true }, // User phone number
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
  customerName: { type: String, default: '' }, // WhatsApp profile name or provided name
  status: { 
    type: String, 
    enum: ['BOT_ACTIVE', 'HUMAN_TAKEOVER', 'CLOSED'], 
    default: 'BOT_ACTIVE' 
  },
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

module.exports = mongoose.model('Conversation', ConversationSchema);
