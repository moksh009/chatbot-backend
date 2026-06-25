'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAdminEmailRecipients,
  buildTakeoverLink,
} = require('../../utils/core/notificationService');

test('resolveAdminEmailRecipients merges adminEmail and adminAlertEmail', () => {
  const emails = resolveAdminEmailRecipients({
    adminEmail: 'founder@brand.com',
    adminAlertEmail: 'ceo@brand.com, support@brand.com',
  });
  assert.equal(emails.length, 3);
  assert.ok(emails.includes('founder@brand.com'));
  assert.ok(emails.includes('ceo@brand.com'));
  assert.ok(emails.includes('support@brand.com'));
});

test('resolveAdminEmailRecipients dedupes and caps recipients', () => {
  const emails = resolveAdminEmailRecipients({
    adminEmail: 'a@test.com',
    adminAlertEmail: 'a@test.com, b@test.com',
  });
  assert.equal(emails.length, 2);
  assert.ok(emails.includes('a@test.com'));
  assert.ok(emails.includes('b@test.com'));
});

test('buildTakeoverLink prefers conversation id', () => {
  const link = buildTakeoverLink({
    baseUrl: 'https://dash.topedgeai.com',
    conversationId: '64abc123',
    customerPhone: '+919876543210',
  });
  assert.equal(link, 'https://dash.topedgeai.com/conversations/64abc123');
});

test('buildTakeoverLink falls back to phone query', () => {
  const link = buildTakeoverLink({
    baseUrl: 'https://dash.topedgeai.com',
    customerPhone: '+919876543210',
  });
  assert.ok(link.includes('phone='));
});
