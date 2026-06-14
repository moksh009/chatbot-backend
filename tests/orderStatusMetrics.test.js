'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateOrderStatusMetrics } = require('../utils/commerce/orderStatusMetrics');

test('aggregateOrderStatusMetrics — 7d counts and success rate', () => {
  const now = Date.parse('2026-05-24T12:00:00.000Z');
  const orders = [
    {
      _id: 'a',
      orderNumber: '#1',
      whatsappActivityLog: [
        { at: '2026-05-23T10:00:00.000Z', event: 'shipped', success: true, templateName: 'eco_shipping_update' },
        { at: '2026-05-20T10:00:00.000Z', event: 'shipped', success: false, reason: 'no_phone', channel: 'template', templateName: 'eco_shipping_update' },
      ],
    },
    {
      _id: 'b',
      orderNumber: '#2',
      whatsappActivityLog: [
        { at: '2026-05-22T10:00:00.000Z', event: 'paid', success: true },
        { at: '2026-01-01T10:00:00.000Z', event: 'paid', success: true },
      ],
    },
  ];

  const { byStatus, failures } = aggregateOrderStatusMetrics(orders, { now });
  assert.equal(byStatus.shipped.count7d, 2);
  assert.equal(byStatus.shipped.success7d, 1);
  assert.equal(byStatus.shipped.failure7d, 1);
  assert.equal(byStatus.shipped.successRate, 50);
  assert.equal(byStatus.paid.count7d, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].orderNumber, '#1');
});

test('aggregateOrderStatusMetrics — ignores non-actionable setup failures', () => {
  const now = Date.parse('2026-05-24T12:00:00.000Z');
  const orders = [
    {
      _id: 'c',
      orderNumber: '#3',
      whatsappActivityLog: [
        {
          at: '2026-05-23T10:00:00.000Z',
          event: 'shipped',
          success: false,
          reason: 'no_template_configured',
          channel: 'none',
        },
        {
          at: '2026-05-23T11:00:00.000Z',
          event: 'shipped',
          success: false,
          reason: 'meta_send_failed',
          channel: 'template',
          templateName: 'eco_shipping_update',
        },
      ],
    },
  ];

  const { failures } = aggregateOrderStatusMetrics(orders, { now });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].reason, 'meta_send_failed');
});
