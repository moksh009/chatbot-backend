'use strict';

const assert = require('assert');
const { formatEmailLogSource, labelSource } = require('../services/emailHubService');

assert.strictEqual(
  formatEmailLogSource({ sequenceName: 'Welcome series' }),
  'Sequence: Welcome series'
);

assert.strictEqual(
  formatEmailLogSource({ source: 'orderStatusAutomationHandler', ruleId: 'sys_financial_paid' }),
  'Order: Paid'
);

assert.strictEqual(
  formatEmailLogSource({ source: 'cron/abandonedCartScheduler', step: 2 }),
  'Cart recovery step 2'
);

assert.strictEqual(labelSource('routes/email-hub:send'), 'Email hub');

console.log('✓ formatEmailLogSource');
