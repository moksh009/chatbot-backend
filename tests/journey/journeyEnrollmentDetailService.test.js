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

// ---------------------------------------------------------------------------
// Regression: branched journey — sent/failed counts must be identical across
// the stats API (getStepFunnel byNodeId) and the detail API (summary.failed).
// This is a pure unit-level check using the shared counting helpers.
// ---------------------------------------------------------------------------
describe('branched journey — counting parity regression', () => {
  const { isStepSent, isStepFailed } = require('../../services/journeyBuilder/journeyStatsService');

  /**
   * Simulate two enrollments through a branched journey (CONDITIONAL_SPLIT).
   * Lead A takes the "Yes" branch (step 0), step succeeds.
   * Lead B takes the "No" branch (step 0 also), step fails with sentAt set
   *   (sent successfully, then Meta reports failure later).
   */
  function makeStepWithNodeId(graphNodeId, status, sentAt = null, failedAt = null) {
    return { graphNodeId, status, sentAt, failedAt, deliveredAt: null, readAt: null, clickedAt: null };
  }

  const NODE_SEND = 'node-send-0';
  const seqA = [makeStepWithNodeId(NODE_SEND, 'sent', new Date())];
  const seqB = [makeStepWithNodeId(NODE_SEND, 'failed', new Date(), new Date())];

  it('isStepSent gives consistent result across both paths', () => {
    assert.equal(isStepSent(seqA[0]), true,  'lead A step: should be sent');
    assert.equal(isStepSent(seqB[0]), false, 'lead B step: failed-after-sent must NOT be sent');
  });

  it('isStepFailed gives consistent result', () => {
    assert.equal(isStepFailed(seqA[0]), false, 'lead A: not failed');
    assert.equal(isStepFailed(seqB[0]), true,  'lead B: failed');
  });

  it('aggregate counts from both enrollments match expected values (no double-counting)', () => {
    const allSteps = [...seqA, ...seqB];
    const sent   = allSteps.filter(isStepSent).length;
    const failed = allSteps.filter(isStepFailed).length;
    // sent+failed must equal 2 (total actionable), not 3 (which would be double-counted)
    assert.equal(sent,          1, 'exactly 1 sent');
    assert.equal(failed,        1, 'exactly 1 failed');
    assert.equal(sent + failed, 2, 'sent + failed === total steps (no double-counting)');
  });

  it('funnelByNodeId entries match per-node sums', () => {
    const allSteps = [...seqA, ...seqB];
    const nodeSent   = allSteps.filter((s) => s.graphNodeId === NODE_SEND && isStepSent(s)).length;
    const nodeFailed = allSteps.filter((s) => s.graphNodeId === NODE_SEND && isStepFailed(s)).length;
    assert.equal(nodeSent,          1);
    assert.equal(nodeFailed,        1);
    assert.equal(nodeSent + nodeFailed, 2, 'no double-counting at node level either');
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
