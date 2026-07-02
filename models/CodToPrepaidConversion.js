'use strict';

const mongoose = require('mongoose');

const CodToPrepaidConversionSchema = new mongoose.Schema({
  clientId: { type: String, required: true, index: true },
  journeyId: { type: String, required: true },
  enrollmentId: { type: String, required: true, index: true },
  contactPhone: { type: String, required: true },
  graphNodeId: { type: String, default: '' },

  originalCodOrderId: { type: String, required: true },
  originalCodOrderName: { type: String, required: true },
  originalCodOrderGid: { type: String, required: true },

  draftOrderId: { type: String, default: null },
  draftOrderName: { type: String, default: null },
  draftOrderGid: { type: String, default: null },
  draftOrderInvoiceUrl: { type: String, default: null },

  metaTemplateId: { type: String, required: true },
  metaTemplateName: { type: String, required: true },

  freezeMode: {
    type: String,
    enum: ['by_duration', 'by_fulfillment_status'],
    required: true,
  },
  expiresAt: { type: Date, default: null },

  status: {
    type: String,
    enum: [
      'draft_order_pending',
      'draft_order_created',
      'message_sent',
      'converted',
      'expired_by_timer',
      'expired_by_fulfillment',
      'draft_creation_failed',
      'message_send_failed',
    ],
    default: 'draft_order_pending',
    index: true,
  },

  draftOrderCreatedAt: { type: Date, default: null },
  messageSentAt: { type: Date, default: null },
  convertedAt: { type: Date, default: null },
  expiredAt: { type: Date, default: null },

  convertedPrepaidOrderId: { type: String, default: null },
  convertedPrepaidOrderGid: { type: String, default: null },

  codCancellationJobId: { type: String, default: null },
  codCancelledAt: { type: Date, default: null },
  codCancellationFailed: { type: Boolean, default: false },
  codCancellationError: { type: String, default: null },

  deletionRetryCount: { type: Number, default: 0 },
  /** Spec Part 5 — failed draftOrderDelete attempts */
  retryCount: { type: Number, default: 0 },

  lastErrorMessage: { type: String, default: null },
  lastErrorAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

CodToPrepaidConversionSchema.index({ clientId: 1, status: 1 });
CodToPrepaidConversionSchema.index({ clientId: 1, enrollmentId: 1 });
CodToPrepaidConversionSchema.index({ clientId: 1, draftOrderId: 1 });
CodToPrepaidConversionSchema.index({ clientId: 1, originalCodOrderId: 1 });
CodToPrepaidConversionSchema.index({ expiresAt: 1, status: 1 });

CodToPrepaidConversionSchema.pre('save', function onSave(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('CodToPrepaidConversion', CodToPrepaidConversionSchema);
