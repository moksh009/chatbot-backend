'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isActionablyOpen,
  dedupeConversationsByPhone,
  capResponseTimeMs,
  medianMs,
  buildReopenAttentionUpdate,
  MAX_AGENT_RESPONSE_MS,
} = require('../../utils/core/supportConversationMetrics');

test('isActionablyOpen excludes resolved unless customer messaged after', () => {
  const base = {
    status: 'HUMAN_TAKEOVER',
    requiresAttention: true,
    resolvedAt: new Date('2026-06-01T10:00:00Z'),
    lastMessageAt: new Date('2026-06-01T10:00:30Z'),
  };
  assert.equal(isActionablyOpen(base), false);

  const reopened = {
    ...base,
    lastMessageAt: new Date('2026-06-01T11:00:00Z'),
  };
  assert.equal(isActionablyOpen(reopened), true);
});

test('dedupeConversationsByPhone keeps latest thread per phone', () => {
  const rows = dedupeConversationsByPhone([
    { _id: 'a', phone: '9199', lastMessageAt: new Date('2026-06-01T09:00:00Z') },
    { _id: 'b', phone: '9199', lastMessageAt: new Date('2026-06-01T12:00:00Z') },
    { _id: 'c', phone: '9188', lastMessageAt: new Date('2026-06-01T08:00:00Z') },
  ]);
  assert.equal(rows.length, 2);
  const latest = rows.find((r) => r.phone === '9199');
  assert.equal(String(latest._id), 'b');
});

test('capResponseTimeMs clamps unrealistic delays', () => {
  assert.equal(capResponseTimeMs(210 * 3600 * 1000), MAX_AGENT_RESPONSE_MS);
  assert.equal(capResponseTimeMs(5000), 5000);
  assert.equal(capResponseTimeMs(null), null);
});

test('medianMs returns middle value', () => {
  assert.equal(medianMs([100, 200, 900]), 200);
  assert.equal(medianMs([100, 200, 300, 400]), 250);
});

test('buildReopenAttentionUpdate clears resolvedAt', () => {
  const patch = buildReopenAttentionUpdate({ status: 'HUMAN_TAKEOVER' });
  assert.equal(patch.$set.requiresAttention, true);
  assert.equal(patch.$set.status, 'HUMAN_TAKEOVER');
  assert.deepEqual(patch.$unset, { resolvedAt: '' });
});
