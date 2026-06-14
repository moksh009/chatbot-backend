'use strict';

const assert = require('assert');
const {
  normalizeEmailConsentStatus,
} = require('../utils/core/emailConsentService');

assert.strictEqual(normalizeEmailConsentStatus('opted_in'), 'opted_in');
assert.strictEqual(normalizeEmailConsentStatus(' opted_out '), 'opted_out');
assert.strictEqual(normalizeEmailConsentStatus('invalid'), null);
assert.strictEqual(normalizeEmailConsentStatus(''), null);

console.log('✓ emailConsentService');
