'use strict';

const mongoose = require('mongoose');

const hashedContactSchema = new mongoose.Schema(
  {
    phoneHash: { type: String, default: null },
    emailHash: { type: String, default: null },
    firstNameHash: { type: String, default: null },
    countryCode: { type: String, default: '91' },
  },
  { _id: false }
);

const metaAudienceQueueSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    audienceType: {
      type: String,
      required: true,
      enum: [
        'store_visitors',
        'product_viewers',
        'cart_abandoners',
        'checkout_abandoners',
        'past_purchasers',
        'custom_segment',
      ],
    },
    productId: { type: String, default: null },
    sizeAtSave: { type: Number, default: 0 },
    hashedContacts: { type: [hashedContactSchema], default: [] },
    pixelSessions: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['saved', 'pushed', 'failed', 'expired'],
      default: 'saved',
    },
    savedAt: { type: Date, default: Date.now },
    pushedAt: { type: Date, default: null },
    metaCustomAudienceId: { type: String, default: null },
    metaPixelAudienceId: { type: String, default: null },
    errorMessage: { type: String, default: null },
    savedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    periodDays: { type: Number, default: 30 },
    criteria: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

metaAudienceQueueSchema.index({ clientId: 1, audienceType: 1, status: 1 });
metaAudienceQueueSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('MetaAudienceQueue', metaAudienceQueueSchema);
