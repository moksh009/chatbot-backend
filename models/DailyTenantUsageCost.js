'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  date: { type: String, required: true },
  usage: { type: mongoose.Schema.Types.Mixed, default: {} },
  costBreakdown: { type: mongoose.Schema.Types.Mixed, default: {} },
  planPriceInr: { type: Number, default: 0 },
}, { timestamps: true });

schema.index({ clientId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('DailyTenantUsageCost', schema);
