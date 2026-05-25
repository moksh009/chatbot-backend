'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  clientId: { type: String, required: true, index: true },
  deliveryId: { type: String, required: true, unique: true },
  event: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, default: {} },
  lastError: { type: String, default: '' },
  lastStatus: { type: Number, default: 0 },
  deliveryAttempts: { type: Number, default: 0 },
  deadLetteredAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('DeadLetterWebhook', schema);
