'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  matchesOptOutKeyword,
  matchesOptInKeyword,
  validateCustomOptOutKeywords,
  extractCustomOptOutKeywords,
  DEFAULT_OPT_OUT_KEYWORDS,
  DEFAULT_OPT_IN_KEYWORDS,
} = require('../utils/commerce/marketingConsentConfig');

describe('marketingConsentConfig', () => {
  it('matches default opt-out keywords case-insensitively', () => {
    const compliance = { customOptOutKeywords: [] };
    assert.equal(matchesOptOutKeyword('STOP', compliance), true);
    assert.equal(matchesOptOutKeyword('stop', compliance), true);
    assert.equal(matchesOptOutKeyword('Unsubscribe please', compliance), true);
    assert.equal(matchesOptOutKeyword('hello', compliance), false);
  });

  it('matches custom opt-out keywords', () => {
    const compliance = { customOptOutKeywords: ['CANCEL'] };
    assert.equal(matchesOptOutKeyword('cancel', compliance), true);
    assert.equal(matchesOptOutKeyword('CANCEL now', compliance), true);
  });

  it('matches only START and SUBSCRIBE for opt-in', () => {
    assert.equal(matchesOptInKeyword('START'), true);
    assert.equal(matchesOptInKeyword('start'), true);
    assert.equal(matchesOptInKeyword('SUBSCRIBE'), true);
    assert.equal(matchesOptInKeyword('subscribe'), true);
    assert.equal(matchesOptInKeyword('START please'), true);
    assert.equal(matchesOptInKeyword('subscribe, me'), true);
    assert.equal(matchesOptInKeyword('start_now'), true);
    assert.equal(matchesOptInKeyword('subscribe-now'), true);
    assert.equal(matchesOptInKeyword('yes'), false);
    assert.equal(matchesOptInKeyword('opt in'), false);
  });

  it('rejects reserved keywords in custom opt-out list', () => {
    const result = validateCustomOptOutKeywords(['STOP', 'FOO']);
    assert.equal(result.ok, false);
  });

  it('limits custom opt-out keywords to five', () => {
    const result = validateCustomOptOutKeywords(['A', 'B', 'C', 'D', 'E', 'F']);
    assert.equal(result.ok, false);
  });

  it('extractCustomOptOutKeywords strips defaults from legacy stopKeywords', () => {
    const custom = extractCustomOptOutKeywords({
      stopKeywords: ['STOP', 'UNSUBSCRIBE', 'REMOVE', 'CANCEL'],
    });
    assert.deepEqual(custom, ['REMOVE', 'CANCEL']);
    assert.deepEqual(DEFAULT_OPT_OUT_KEYWORDS, ['STOP', 'UNSUBSCRIBE']);
    assert.deepEqual(DEFAULT_OPT_IN_KEYWORDS, ['START', 'SUBSCRIBE']);
  });
});
