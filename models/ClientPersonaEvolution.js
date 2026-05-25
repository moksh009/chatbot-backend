'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  version: { type: Number, required: true },
  generatedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['pending', 'activated', 'dismissed'], default: 'pending' },
  basedOn: {
    trainingCaseIds: [{ type: String }],
    messageCount: { type: Number, default: 0 },
  },
  personaText: { type: String, default: '' },
  previousPersonaText: { type: String, default: '' },
  exampleReplies: [{ type: String }],
  evaluatorScore: { type: Number, default: null },
  activatedAt: { type: Date, default: null },
  activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
});

schema.index({ clientId: 1, version: -1 });

module.exports = mongoose.model('ClientPersonaEvolution', schema);
