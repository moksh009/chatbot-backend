const mongoose = require('mongoose');

const segmentSchema = new mongoose.Schema({
  clientId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  // The MongoDB query object (e.g. { leadScore: { $gt: 50 }, cartStatus: 'abandoned' })
  query: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  // The natural language prompt used to generate this segment
  prompt: {
    type: String
  },
  type: {
    type: String,
    enum: ['dynamic', 'static'],
    default: 'dynamic'
  },
  lastCount: {
    type: Number,
    default: 0
  },
  lastCountAt: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Segment', segmentSchema);
