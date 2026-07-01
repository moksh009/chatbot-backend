'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePeriod,
  MIN_SAMPLE_SIZE,
  isStepSent,
  isStepFailed,
  isStepSkipped,
  enrichFunnelStepsWithCompiledGraph,
} = require('../../services/journeyBuilder/journeyStatsService');
const { JOURNEY_NODE_TYPES } = require('../../services/journeyBuilder/journeyNodeContract');

describe('journeyStatsService', () => {
  describe('parsePeriod', () => {
    it('parses 7d period with from date', () => {
      const p = parsePeriod('7d');
      assert.ok(p.from instanceof Date);
      assert.ok(p.to instanceof Date);
      assert.equal(p.label, '7d');
      assert.ok(p.to.getTime() - p.from.getTime() >= 6 * 24 * 60 * 60 * 1000);
    });

    it('all-time has null from', () => {
      const p = parsePeriod('all');
      assert.equal(p.from, null);
      assert.equal(p.label, 'all');
    });
  });

  describe('MIN_SAMPLE_SIZE', () => {
    it('is 10 per honest metrics contract', () => {
      assert.equal(MIN_SAMPLE_SIZE, 10);
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: sent/failed mutual exclusivity (FSM fix)
// A step that was sent (sentAt set) but later moved to failed by a Meta webhook
// must count in FAILED only — not in both sent AND failed.
// ---------------------------------------------------------------------------
describe('isStepSent / isStepFailed — mutual exclusivity', () => {
  it('normal sent step counts as sent, not failed', () => {
    const step = { status: 'sent', sentAt: new Date() };
    assert.equal(isStepSent(step), true);
    assert.equal(isStepFailed(step), false);
  });

  it('failed step with sentAt counts as failed ONLY — not double-counted as sent', () => {
    // This is the double-counting bug scenario:
    // step was sent (sentAt populated), later Meta webhook moved status to 'failed'
    const step = { status: 'failed', sentAt: new Date(), failedAt: new Date() };
    assert.equal(isStepSent(step), false, 'failed step must NOT count in sent');
    assert.equal(isStepFailed(step), true, 'failed step must count in failed');
  });

  it('failed step without sentAt still counts as failed', () => {
    const step = { status: 'failed', sentAt: null, failureReason: 'template_not_approved' };
    assert.equal(isStepSent(step), false);
    assert.equal(isStepFailed(step), true);
  });

  it('pending step counts in neither bucket', () => {
    const step = { status: 'pending', sentAt: null };
    assert.equal(isStepSent(step), false);
    assert.equal(isStepFailed(step), false);
  });

  it('step with sentAt but status not sent or failed — counts as sent', () => {
    // e.g. transition race left status=processing but message was delivered
    const step = { status: 'processing', sentAt: new Date() };
    assert.equal(isStepSent(step), true);
    assert.equal(isStepFailed(step), false);
  });

  it('skipped step counts only in skipped bucket', () => {
    const step = { status: 'skipped', skipReason: 'email_opted_out' };
    assert.equal(isStepSkipped(step), true);
    assert.equal(isStepSent(step), false);
    assert.equal(isStepFailed(step), false);
  });
});

describe('enrichFunnelStepsWithCompiledGraph', () => {
  it('fills email templateName from published graph when sequence steps omit it', () => {
    const graph = {
      nodes: [
        {
          id: 'trigger_1',
          type: JOURNEY_NODE_TYPES.JOURNEY_TRIGGER,
          data: { nodeType: JOURNEY_NODE_TYPES.JOURNEY_TRIGGER, entryType: 'order_placed' },
        },
        {
          id: 'send_email_1',
          type: JOURNEY_NODE_TYPES.SEND_EMAIL,
          data: {
            nodeType: JOURNEY_NODE_TYPES.SEND_EMAIL,
            templateName: 'Order confirmed',
            subject: 'Your order {{order_number}} is confirmed! ✅',
            content: '<p>Thanks</p>',
          },
        },
        {
          id: 'end_1',
          type: JOURNEY_NODE_TYPES.END,
          data: { nodeType: JOURNEY_NODE_TYPES.END },
        },
      ],
      edges: [
        { id: 'e1', source: 'trigger_1', target: 'send_email_1' },
        { id: 'e2', source: 'send_email_1', target: 'end_1' },
      ],
    };

    const enriched = enrichFunnelStepsWithCompiledGraph(graph, [
      { stepIndex: 0, type: 'email', templateName: '', subject: '' },
    ]);

    assert.equal(enriched[0].templateName, 'Order confirmed');
    assert.match(enriched[0].subject, /confirmed/);
  });
});

describe('journeyAttributionHelper', () => {
  const { updateJourneyStepStatus } = require('../../utils/commerce/journeyAttributionHelper');

  it('updateJourneyStepStatus returns false without messageId', async () => {
    const result = await updateJourneyStepStatus({ messageId: '', status: 'read' });
    assert.equal(result, false);
  });
});
