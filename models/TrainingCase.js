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
    enum: ['pending', 'active', 'processed', 'ignored', 'rejected', 'flagged_for_review', 'approved'],
    default: 'pending',
  },
  botReplyCorrection: { type: String, default: '' },
  tags: { type: [String], default: [] },
  rejectReason: { type: String, default: '' },
  approvedAt: { type: Date },
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  rejectedAt: { type: Date },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  embedding: { type: [Number], default: [] },
  helpfulCount: { type: Number, default: 0 },
  lessHelpfulCount: { type: Number, default: 0 },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('TrainingCase', TrainingCaseSchema);
