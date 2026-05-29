'use strict';

/**
 * ConnectionEvent — audit trail for every WhatsApp Embedded Signup attempt.
 * NEVER store tokens, codes, or secrets in this model.
 * Retention: 90 days (cleanup cron should purge older docs).
 */

const mongoose = require('mongoose');

const STAGES = [
  'initiated',
  'popup_completed',
  'token_exchange_started',
  'token_exchange_success',
  'token_exchange_failed',
  'phone_registered',
  'webhook_subscribed',
  'connection_finalized',
  'failed',
];

const ConnectionEventSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    service: {
      type: String,
      enum: ['whatsapp_embedded_signup', 'whatsapp_manual'],
      default: 'whatsapp_embedded_signup',
    },
    stage: { type: String, enum: STAGES, required: true },
    error: {
      category: { type: String, enum: ['network', 'meta_api', 'validation', 'auth', 'other'], default: null },
      message: { type: String, default: null },
    },
    metadata: {
      wabaId: { type: String, default: null },
      phoneNumberId: { type: String, default: null },
      coexistence: { type: Boolean, default: false },
      durationMs: { type: Number, default: null },
      ip: { type: String, default: null },
      userAgent: { type: String, default: null },
      metaErrorCode: { type: Number, default: null },
    },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 90 }, // 90-day TTL
  },
  { versionKey: false }
);

ConnectionEventSchema.index({ clientId: 1, sessionId: 1, createdAt: -1 });

module.exports = mongoose.model('ConnectionEvent', ConnectionEventSchema);
