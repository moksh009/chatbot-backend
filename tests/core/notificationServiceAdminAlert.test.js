'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAdminAlertTemplateName,
  buildAdminAlertWhatsAppComponents,
} = require('../../utils/core/notificationService');

test('resolveAdminAlertTemplateName prefers approved admin_human_alert', () => {
  const name = resolveAdminAlertTemplateName({
    syncedMetaTemplates: [
      { name: 'admin_notification_v1', status: 'APPROVED' },
      { name: 'admin_human_alert', status: 'APPROVED' },
    ],
  });
  assert.equal(name, 'admin_human_alert');
});

test('buildAdminAlertWhatsAppComponents maps admin_human_alert body slots', () => {
  const components = buildAdminAlertWhatsAppComponents('admin_human_alert', {
    customerPhone: '+919876543210',
    topic: 'VIP lead',
    triggerSource: 'Checkout page',
    customerQuery: 'Priya Sharma',
  });
  assert.equal(components.length, 1);
  assert.equal(components[0].type, 'body');
  assert.deepEqual(components[0].parameters.map((p) => p.text), [
    'Priya Sharma',
    '+919876543210',
    'VIP lead — Checkout page',
  ]);
});
