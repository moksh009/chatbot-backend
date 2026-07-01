'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveEnrollStatus } = require('../../services/journeyBuilder/journeyEnrollPreflightService');

test('WA-only journey blocks opted-out lead', () => {
  const r = resolveEnrollStatus({
    hasWaSteps: true,
    hasEmailSteps: false,
    waStatus: 'skipped',
    emailStatus: null,
    warnings: [{ code: 'wa_opted_out' }],
  });
  assert.equal(r.enrollStatus, 'blocked');
});

test('dual-channel partial when one channel skipped', () => {
  const r = resolveEnrollStatus({
    hasWaSteps: true,
    hasEmailSteps: true,
    waStatus: 'eligible',
    emailStatus: 'skipped',
    warnings: [{ code: 'email_opted_out' }],
  });
  assert.equal(r.enrollStatus, 'partial');
});

test('eligible when all channels usable', () => {
  const r = resolveEnrollStatus({
    hasWaSteps: true,
    hasEmailSteps: true,
    waStatus: 'eligible',
    emailStatus: 'eligible',
    warnings: [],
  });
  assert.equal(r.enrollStatus, 'eligible');
});
