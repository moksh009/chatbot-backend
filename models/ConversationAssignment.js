const mongoose = require('mongoose');

const ConversationAssignmentSchema = new mongoose.Schema({
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  clientId: { type: String, required: true, index: true },
  assignedAgentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedAt: { type: Date, default: Date.now, index: true }
});

module.exports = mongoose.model('ConversationAssignment', ConversationAssignmentSchema);
