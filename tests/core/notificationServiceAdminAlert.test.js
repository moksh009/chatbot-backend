'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAdminEmailRecipients,
  buildTakeoverLink,
  buildAdminAlertDedupKey,
  parseRecipientList,
} = require('../../utils/core/notificationService');
const {
  stripWhatsAppFormatting,
  buildAdminEscalationSubject,
  buildAdminEscalationEmailHtml,
  buildAdminEscalationEmailText,
  pickLastCustomerMessage,
} = require('../../utils/core/adminEscalationEmailTemplate');

test('resolveAdminEmailRecipients uses alert emails only when set', () => {
  const emails = resolveAdminEmailRecipients({
    adminEmail: 'founder@brand.com',
    adminAlertEmail: 'ceo@brand.com, support@brand.com',
  });
  assert.equal(emails.length, 2);
  assert.ok(emails.includes('ceo@brand.com'));
  assert.ok(emails.includes('support@brand.com'));
  assert.ok(!emails.includes('founder@brand.com'));
});

test('resolveAdminEmailRecipients falls back to adminEmail when alert list empty', () => {
  const emails = resolveAdminEmailRecipients({
    adminEmail: 'founder@brand.com',
    adminAlertEmail: '',
  });
  assert.deepEqual(emails, ['founder@brand.com']);
});

test('resolveAdminEmailRecipients dedupes alert list', () => {
  const emails = resolveAdminEmailRecipients({
    adminAlertEmail: 'a@test.com, a@test.com, b@test.com',
  });
  assert.equal(emails.length, 2);
});

test('buildAdminAlertDedupKey ignores topic — uses phone and conversation', () => {
  const keyA = buildAdminAlertDedupKey('client_a', '+919876543210', 'convo123', '');
  const keyB = buildAdminAlertDedupKey('client_a', '+919876543210', 'convo123', '');
  const keyC = buildAdminAlertDedupKey('client_a', '+919876543210', 'other', '');
  assert.equal(keyA, keyB);
  assert.notEqual(keyA, keyC);
  assert.match(keyA, /admin_alert:client_a:/);
  assert.ok(!keyA.includes('topic'));
});

test('buildAdminAlertDedupKey uses dedupBucket when provided', () => {
  const key = buildAdminAlertDedupKey('client_a', '+91', null, 'test');
  assert.equal(key, 'admin_alert:client_a:test');
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

test('stripWhatsAppFormatting removes bold markers', () => {
  assert.equal(stripWhatsAppFormatting('*Need help?*'), 'Need help?');
});

test('buildAdminEscalationSubject leads with alert and human help needed', () => {
  const subject = buildAdminEscalationSubject({
    brandName: 'Apex Light',
    customerPhone: '+919313045439',
  });
  assert.match(subject, /^🚨 Human help needed/);
  assert.match(subject, /Apex Light/);
  assert.match(subject, /\+91/);
  assert.ok(!subject.startsWith('Apex Light'));
});

test('buildAdminEscalationEmailHtml uses compact mobile padding and alert header', () => {
  const html = buildAdminEscalationEmailHtml({
    brandName: 'Apex Light',
    customerPhone: '+919313045439',
    customerName: 'Rahul',
    triggerSource: 'Flow',
    takeoverLink: 'https://dash.topedgeai.com/conversations/abc',
    isTest: true,
  });
  assert.match(html, /Human help needed/);
  assert.match(html, /te-wrap/);
  assert.match(html, /padding:8px/);
  assert.match(html, /Test alert/);
  assert.match(html, /#7c3aed/);
});

test('pickLastCustomerMessage returns last inbound line', () => {
  const msg = pickLastCustomerMessage([
    { direction: 'outbound', content: 'Bot hello' },
    { direction: 'incoming', content: '*Talk to human*' },
  ]);
  assert.equal(msg, 'Talk to human');
});

test('buildAdminEscalationEmailText includes plain link', () => {
  const text = buildAdminEscalationEmailText({
    brandName: 'Apex Light',
    customerPhone: '+919313045439',
    takeoverLink: 'https://dash.topedgeai.com/conversations/abc',
    isTest: true,
  });
  assert.match(text, /Human help needed/);
  assert.match(text, /conversations\/abc/);
});

test('parseRecipientList splits comma and newline', () => {
  assert.deepEqual(parseRecipientList('a@x.com, b@x.com\nc@x.com'), [
    'a@x.com',
    'b@x.com',
    'c@x.com',
  ]);
});
