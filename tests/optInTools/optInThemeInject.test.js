'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOptInScriptTag,
  themeHasOptInScript,
  injectOptInScriptIntoLiquid,
  removeOptInScriptFromLiquid,
} = require('../../utils/optIn/optInThemeInject');

describe('optInThemeInject', () => {
  const clientId = 'tenant_test_01';
  const embedKey = 'a'.repeat(48);
  const backendUrl = 'https://api.topedgeai.com';
  const baseLiquid = '<html><body><p>Shop</p></body></html>';

  it('buildOptInScriptTag includes marker, key, and client id', () => {
    const tag = buildOptInScriptTag(backendUrl, embedKey, clientId);
    assert.match(tag, /TopEdge Opt-In Tools/);
    assert.match(tag, /topedge-opt-in\.js/);
    assert.match(tag, new RegExp(`data-embed-key="${embedKey}"`));
    assert.match(tag, new RegExp(`data-client-id="${clientId}"`));
  });

  it('inject is idempotent when snippet already present', () => {
    const tag = buildOptInScriptTag(backendUrl, embedKey, clientId);
    const liquid = baseLiquid.replace('</body>', `${tag}</body>`);
    assert.equal(themeHasOptInScript(liquid, clientId), true);
    const result = injectOptInScriptIntoLiquid(liquid, backendUrl, embedKey, clientId);
    assert.equal(result.alreadyPresent, true);
    assert.equal(result.liquid, liquid);
  });

  it('inject inserts before closing body', () => {
    const result = injectOptInScriptIntoLiquid(baseLiquid, backendUrl, embedKey, clientId);
    assert.equal(result.alreadyPresent, false);
    assert.match(result.liquid, /TopEdge Opt-In Tools/);
    assert.ok(result.liquid.indexOf('</body>') > result.liquid.indexOf('topedge-opt-in.js'));
  });

  it('remove strips opt-in block', () => {
    const tag = buildOptInScriptTag(backendUrl, embedKey, clientId);
    const liquid = baseLiquid.replace('</body>', `${tag}</body>`);
    const result = removeOptInScriptFromLiquid(liquid, clientId);
    assert.equal(result.removed, true);
    assert.equal(themeHasOptInScript(result.liquid, clientId), false);
  });
});
