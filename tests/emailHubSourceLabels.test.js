'use strict';

const assert = require('assert');
const { formatEmailLogSource, labelSource } = require('../services/emailHubService');

assert.strictEqual(
  formatEmailLogSource({ sequenceName: 'Welcome series' }),
  'Sequence: Welcome series'
);

assert.strictEqual(
  formatEmailLogSource({ source: 'orderStatusAutomationHandler', ruleId: 'sys_fulfillment_unfulfilled' }),
  'Order: Order placed'
);

assert.strictEqual(
  formatEmailLogSource({ source: 'orderStatusAutomationHandler', ruleId: 'sys_financial_paid' }),
  'Order: Order placed (legacy)'
);

assert.strictEqual(
  formatEmailLogSource({ source: 'cron/abandonedCartScheduler', step: 2 }),
  'Cart recovery step 2'
);

assert.strictEqual(labelSource('routes/email-hub:send'), 'Email hub');
assert.strictEqual(labelSource('routes/conversations:send-email'), 'Live chat');
assert.strictEqual(
  formatEmailLogSource({ source: 'routes/conversations:send-email' }),
  'Live chat'
);

console.log('✓ formatEmailLogSource');
