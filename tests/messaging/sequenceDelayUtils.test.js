'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  delayValueToMs,
  mapStepsWithCumulativeSendAt,
  normalizeDelayUnit,
} = require('../../utils/messaging/sequenceDelayUtils');

test('delayValueToMs respects hours and days', () => {
  assert.equal(delayValueToMs(2, 'h'), 7200000);
  assert.equal(delayValueToMs(1, 'd'), 86400000);
  assert.equal(delayValueToMs(15, 'minutes'), 900000);
});

test('mapStepsWithCumulativeSendAt chains delays', () => {
  const start = new Date('2026-06-16T10:00:00.000Z');
  const mapped = mapStepsWithCumulativeSendAt(
    [
      { delayValue: 1, delayUnit: 'h' },
      { delayValue: 30, delayUnit: 'm' },
    ],
    { start }
  );
  assert.equal(mapped.length, 2);
  assert.equal(mapped[0].sendAt.toISOString(), '2026-06-16T11:00:00.000Z');
  assert.equal(mapped[1].sendAt.toISOString(), '2026-06-16T11:30:00.000Z');
  assert.equal(normalizeDelayUnit('hours'), 'h');
});
