'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildActivityTimeline } = require('../utils/customer360/buildActivityTimeline');

test('buildActivityTimeline merges sources and sorts newest first', () => {
  const lead = {
    createdAt: new Date('2024-01-01'),
    activityLog: [{ action: 'add_to_cart', timestamp: new Date('2024-02-01') }],
    channelConsent: {
      whatsapp: { status: 'opted_in', optInAt: new Date('2024-03-01') },
    },
  };
  const events = buildActivityTimeline({
    lead,
    orders: [{ createdAt: new Date('2024-04-01'), totalPrice: 99 }],
    messages: [{ direction: 'inbound', content: 'Hi', timestamp: new Date('2024-05-01') }],
    marketingLogs: [
      {
        status: 'sent',
        sentAt: new Date('2024-06-01'),
        campaignId: { name: 'Spring sale' },
      },
    ],
    sequences: [{ name: 'Cart drip', status: 'active', createdAt: new Date('2024-07-01') }],
    conversation: { createdAt: new Date('2024-08-01') },
  });

  assert.ok(events.length >= 6);
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(new Date(events[i - 1].timestamp) >= new Date(events[i].timestamp));
  }
});

test('buildActivityTimeline dedupes identical keys', () => {
  const ts = new Date('2024-01-15');
  const lead = {
    createdAt: ts,
    activityLog: [{ action: 'lead_created', timestamp: ts }],
  };
  const events = buildActivityTimeline({ lead, orders: [], messages: [], marketingLogs: [], sequences: [] });
  const leadCreated = events.filter((e) => e.eventName === 'Lead created');
  assert.equal(leadCreated.length, 1);
});
