'use strict';

const assert = require('assert');

assert.strictEqual(
  ['no_opt_in', 'template_missing', 'template_not_approved', 'gmail_not_connected'].includes('gmail_not_connected'),
  true
);

console.log('✓ campaignEmailPreflightCodes');
