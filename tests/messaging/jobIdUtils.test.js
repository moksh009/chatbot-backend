'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeBullMqJobId,
  campaignMessageJobId,
  sequenceStepJobId,
  webhookDeliveryJobId,
  signupWelcomeJobId,
  inboundEngineJobId,
  nlpProcessJobId,
} = require('../../utils/messaging/queues/jobIdUtils');

test('sanitizeBullMqJobId removes colons and joins with hyphen', () => {
  const id = sanitizeBullMqJobId('cm', '507f1f77bcf86cd799439011');
  assert.ok(!id.includes(':'), `job id must not contain colon: ${id}`);
  assert.equal(id, 'cm-507f1f77bcf86cd799439011');
});

test('campaignMessageJobId never contains colon', () => {
  const id = campaignMessageJobId('abc:def:ghi');
  assert.ok(!id.includes(':'));
  assert.equal(id, 'cm-abc-def-ghi');
});

test('sequenceStepJobId never contains colon', () => {
  const id = sequenceStepJobId('seq1', 2);
  assert.ok(!id.includes(':'));
  assert.equal(id, 'seq-seq1-2');
});

test('webhookDeliveryJobId never contains colon', () => {
  const id = webhookDeliveryJobId('del-uuid', 3);
  assert.ok(!id.includes(':'));
});

test('signupWelcomeJobId never contains colon', () => {
  const id = signupWelcomeJobId('user:123');
  assert.ok(!id.includes(':'));
});

test('inboundEngineJobId never contains colon', () => {
  const id = inboundEngineJobId('client1', '+919876543210');
  assert.ok(!id.includes(':'));
  assert.match(id, /^inbound-client1-/);
});

test('nlpProcessJobId never contains colon', () => {
  const id = nlpProcessJobId('client1', '919876543210');
  assert.ok(!id.includes(':'));
  assert.equal(id, 'nlp-client1-919876543210');
});
