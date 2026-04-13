const mongoose = require('mongoose');

const TrainingExampleSchema = new mongoose.Schema({
  clientId:       { type: String, required: true },
  
  // The situation
  userMessage:    { type: String, required: true },   // what the customer said
  botResponse:    { type: String, required: true },   // what the bot said (wrong or suboptimal)
  
  // The correction
  agentCorrection: { type: String, required: true },   // what the agent said instead (the right answer)
  correctedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  correctedAt:     { type: Date, default: Date.now },
  
  // Context
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation' },
  phone:          { type: String },
  topic:          { type: String, default: "general" }, // auto-detected: "returns" | "delivery" | "product_info"
  
  // For retrieval
  embeddingKey:   { type: String },   // simplified keyword vector for fast lookup
  useCount:       { type: Number, default: 0 },   // how many times this example was used in prompts
  
  isActive:       { type: Boolean, default: true },
  createdAt:      { type: Date, default: Date.now }
});

TrainingExampleSchema.index({ clientId: 1, isActive: 1, topic: 1 });
TrainingExampleSchema.index({ clientId: 1, useCount: -1 });

module.exports = mongoose.model('TrainingExample', TrainingExampleSchema);
