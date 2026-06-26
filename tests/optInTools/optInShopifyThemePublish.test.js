'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatOptInThemeInjectError,
  pickMainTheme,
} = require('../../utils/optIn/optInShopifyThemePublish');

describe('optInShopifyThemePublish', () => {
  it('pickMainTheme prefers main role', () => {
    const themes = [
      { id: 1, role: 'unpublished' },
      { id: 2, role: 'main' },
    ];
    assert.equal(pickMainTheme(themes).id, 2);
  });

  it('formatOptInThemeInjectError maps 404 to actionable message', () => {
    const err = { response: { status: 404, data: { errors: 'Not Found' } } };
    const result = formatOptInThemeInjectError(err);
    assert.equal(result.success, false);
    assert.equal(result.code, 'THEME_NOT_WRITABLE');
    assert.match(result.message, /Online Store/);
  });

  it('formatOptInThemeInjectError maps scope errors to reconnect guidance', () => {
    const err = { response: { status: 403, data: { errors: 'write_themes scope required' } } };
    const result = formatOptInThemeInjectError(err);
    assert.equal(result.code, 'SHOPIFY_SCOPE');
    assert.match(result.message, /write_themes/);
  });
});
