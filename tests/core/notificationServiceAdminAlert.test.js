'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAdminAlertTemplateName,
  isAdminAlertTemplateApproved,
  buildAdminAlertWhatsAppComponents,
  templateHasUrlButton,
} = require('../../utils/core/notificationService');

const sampleClient = {
  syncedMetaTemplates: [
    { name: 'admin_notification_v1', status: 'APPROVED' },
    { name: 'admin_human_alert', status: 'APPROVED', components: [
      { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://dash.topedgeai.com/conversations/{{1}}' }] },
    ] },
  ],
};

test('resolveAdminAlertTemplateName prefers approved admin_human_alert', () => {
  const name = resolveAdminAlertTemplateName(sampleClient);
  assert.equal(name, 'admin_human_alert');
});

test('resolveAdminAlertTemplateName returns null when none approved', () => {
  const name = resolveAdminAlertTemplateName({ syncedMetaTemplates: [{ name: 'admin_human_alert', status: 'PENDING' }] });
  assert.equal(name, null);
});

test('isAdminAlertTemplateApproved detects approved template', () => {
  assert.equal(isAdminAlertTemplateApproved(sampleClient, 'admin_human_alert'), true);
  assert.equal(isAdminAlertTemplateApproved(sampleClient, 'missing_tpl'), false);
});

test('buildAdminAlertWhatsAppComponents maps admin_human_alert body slots and URL button', () => {
  const components = buildAdminAlertWhatsAppComponents('admin_human_alert', sampleClient, {
    customerPhone: '+919876543210',
    topic: 'VIP lead',
    triggerSource: 'Checkout page',
    customerQuery: 'Priya Sharma',
    customerName: 'Priya Sharma',
    conversationId: '64abc123def456',
  });
  assert.equal(components.length, 2);
  assert.equal(components[0].type, 'body');
  assert.deepEqual(components[0].parameters.map((p) => p.text), [
    'Priya Sharma',
    '+919876543210',
    'VIP lead — Checkout page — Priya Sharma',
  ]);
  assert.equal(components[1].type, 'button');
  assert.equal(components[1].sub_type, 'url');
  assert.equal(components[1].parameters[0].text, '64abc123def456');
});

test('templateHasUrlButton defaults true for admin_human_alert without sync metadata', () => {
  assert.equal(templateHasUrlButton({}, 'admin_human_alert'), true);
  assert.equal(
    templateHasUrlButton({ syncedMetaTemplates: [{ name: 'admin_human_alert', components: [{ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY' }] }] }] }, 'admin_human_alert'),
    false
  );
});
