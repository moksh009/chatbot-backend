'use strict';

const mongoose = require('mongoose');

const aiTokenTransactionSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  timestamp: { type: Date, default: Date.now, index: true },
  feature: {
    type: String,
    enum: [
      'whatsapp_bot',
      'knowledge_test',
      'template_gen',
      'flow_builder',
      'persona_gen',
      'persona_preview',
      'embedding',
      'other',
    ],
  },
  provider: { type: String, enum: ['gemini', 'openai'], default: 'gemini' },
  model: { type: String },
  inputTokens: { type: Number, default: 0 },
  outputTokens: { type: Number, default: 0 },
  totalTokens: { type: Number, default: 0 },
  costUsd: { type: Number, default: 0 },
  source: { type: String, enum: ['byo'], default: 'byo' },
  success: { type: Boolean, default: true },
  errorCode: { type: String, default: null },
});

aiTokenTransactionSchema.index({ clientId: 1, timestamp: -1 });
aiTokenTransactionSchema.index({ clientId: 1, feature: 1, timestamp: -1 });

module.exports = mongoose.model('AiTokenTransaction', aiTokenTransactionSchema);
