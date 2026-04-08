const mongoose = require('mongoose');

const TrainingCaseSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  userMessage: {
    type: String,
    required: true
  },
  botResponse: {
    type: String,
    required: true
  },
  agentCorrection: {
    type: String,
    required: true
  },
  conversationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation'
  },
  phone: String,
  status: {
    type: String,
    enum: ['pending', 'processed', 'ignored'],
    default: 'pending'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('TrainingCase', TrainingCaseSchema);
