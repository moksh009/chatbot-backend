'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  maskPhone,
  maskEmail,
  mapStepEngagement,
  summarizeRecipientEngagement,
  buildSummaryFromStats,
} = require('../../services/journeyBuilder/journeyEnrollmentDetailService');

describe('journeyEnrollmentDetailService', () => {
  describe('maskPhone', () => {
    it('masks all but last 4 digits', () => {
      assert.equal(maskPhone('+919876543210'), '••••3210');
    });
  });

  describe('maskEmail', () => {
    it('masks local part', () => {
      assert.equal(maskEmail('priya@example.com'), 'pr••@example.com');
    });
  });

  describe('mapStepEngagement', () => {
    it('marks clicked when clickedAt present', () => {
      const row = mapStepEngagement({
        type: 'whatsapp',
        templateName: 'cart_recovery_1',
        status: 'sent',
        sentAt: new Date('2026-06-01'),
        deliveredAt: new Date('2026-06-01'),
        clickedAt: new Date('2026-06-02'),
        clickType: 'button',
      }, 0);
      assert.equal(row.outcome, 'clicked');
      assert.equal(row.clickType, 'button');
    });

    it('marks read from WA read receipt', () => {
      const row = mapStepEngagement({
        type: 'whatsapp',
        status: 'sent',
        readAt: new Date('2026-06-02'),
      }, 1);
      assert.equal(row.outcome, 'read');
    });
  });

  describe('summarizeRecipientEngagement', () => {
    it('prioritizes purchased outcome when orders exist', () => {
      const summary = summarizeRecipientEngagement(
        [{ status: 'sent', sentAt: new Date(), readAt: new Date() }],
        [{ amount: 1299, orderKey: 'o1' }]
      );
      assert.equal(summary.bestOutcome, 'purchased');
      assert.equal(summary.revenueInr, 1299);
      assert.equal(summary.attributedOrders, 1);
    });
  });

  describe('buildSummaryFromStats', () => {
    it('computes rates from raw counts', () => {
      const s = buildSummaryFromStats({
        sent: 10,
        delivered: 10,
        read: 5,
        clicked: 2,
        uniqueRecipients: 8,
        attributedOrders: 1,
        revenueInr: 500,
      });
      assert.equal(s.openRate, 0.5);
      assert.equal(s.clickRate, 0.2);
      assert.equal(s.orderRate, 0.125);
      assert.equal(s.lowVolume, false);
    });
  });
});

describe('journeyAttributionHelper extensions', () => {
  const {
    updateJourneyStepClick,
    updateJourneyStepFromEnvelope,
  } = require('../../utils/commerce/journeyAttributionHelper');

  it('updateJourneyStepClick returns false without messageId', async () => {
    const result = await updateJourneyStepClick({ messageId: '' });
    assert.equal(result, false);
  });

  it('updateJourneyStepFromEnvelope returns false without envelopeId', async () => {
    const result = await updateJourneyStepFromEnvelope({ envelopeId: null, type: 'open' });
    assert.equal(result, false);
  });
});
