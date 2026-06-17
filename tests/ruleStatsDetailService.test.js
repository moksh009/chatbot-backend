'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maskPhone } = require('../utils/commerce/ruleStatsDetailService');

test('maskPhone masks all but last 4 digits', () => {
  assert.equal(maskPhone('919876543210'), '••••3210');
  assert.equal(maskPhone('+91 98765 43210'), '••••3210');
});

test('maskPhone returns dash for short values', () => {
  assert.equal(maskPhone(''), '—');
  assert.equal(maskPhone('12'), '—');
});
