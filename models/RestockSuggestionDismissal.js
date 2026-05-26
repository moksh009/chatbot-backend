'use strict';

const mongoose = require('mongoose');

const RestockSuggestionDismissalSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    sku: { type: String, required: true },
    snoozedUntil: { type: Date, required: true },
    reason: { type: String, default: '' },
  },
  { timestamps: true }
);

RestockSuggestionDismissalSchema.index({ clientId: 1, sku: 1 }, { unique: true });

module.exports = mongoose.model('RestockSuggestionDismissal', RestockSuggestionDismissalSchema);
