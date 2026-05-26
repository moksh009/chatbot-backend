'use strict';

const mongoose = require('mongoose');

const StockoutEventSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    sku: { type: String, required: true },
    locationId: { type: String, default: 'default' },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    durationHours: { type: Number, default: null },
    channelsAffected: [{ type: String }],
    estimatedLostSales: { type: Number, default: 0 },
    velocityAtStart: { type: Number, default: 0 },
    averageOrderValue: { type: Number, default: 0 },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
  },
  { timestamps: true }
);

StockoutEventSchema.index({ clientId: 1, sku: 1, status: 1 });
StockoutEventSchema.index({ clientId: 1, startedAt: -1 });

module.exports = mongoose.model('StockoutEvent', StockoutEventSchema);
