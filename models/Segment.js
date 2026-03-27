const mongoose = require('mongoose');

const SegmentSchema = new mongoose.Schema({
  clientId: { type: String, required: true },
  name: { type: String, required: true },
  conditions: [{
    field: String, // "leadScore", "intentState", "cartValue" etc
    operator: String, // "gte", "lte", "eq", "in", "exists"
    value: mongoose.Schema.Types.Mixed
  }],
  logic: { type: String, enum: ["AND","OR"], default: "AND" },
  lastCount: { type: Number, default: 0 },
  lastCountedAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Segment', SegmentSchema);
