'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { logDispatchEvent } = require('../../utils/messaging/dispatchEventLog');

test('logDispatchEvent emits structured payload with event name', () => {
  const original = console.log;
  let captured = '';
  console.log = (msg) => {
    captured = String(msg);
  };
  try {
    logDispatchEvent('TestDispatch', 'campaign_message_sent', {
      clientId: 'tenant_alpha',
      campaignId: 'abc',
      outcome: 'sent',
    });
    assert.match(captured, /campaign_message_sent/);
    assert.match(captured, /tenant_alpha/);
    assert.match(captured, /"outcome":"sent"/);
  } finally {
    console.log = original;
  }
});

test('logDispatchEvent skips verbose skip paths by default', () => {
  const original = console.log;
  let called = false;
  console.log = () => {
    called = true;
  };
  try {
    logDispatchEvent('TestDispatch', 'order_message_skipped', {
      clientId: 'x',
      outcome: 'skipped',
      skipReason: 'already_sent',
    });
    assert.equal(called, false);
  } finally {
    console.log = original;
  }
});
