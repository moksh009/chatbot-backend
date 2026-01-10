const mongoose = require('mongoose');

const ConversationSchema = new mongoose.Schema({
  phone: { type: String, required: true }, // User phone number
  clientId: { type: String, required: true, default: 'code_clinic_v1' },
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
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Compound index for unique conversation per phone + client
ConversationSchema.index({ phone: 1, clientId: 1 }, { unique: true });

module.exports = mongoose.model('Conversation', ConversationSchema);
