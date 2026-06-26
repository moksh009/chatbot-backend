'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assertSafeUrl, extractBrandFromUrl } = require('../../services/optInBrandExtractService');

describe('optInBrandExtractService', () => {
  it('assertSafeUrl blocks localhost', async () => {
    await assert.rejects(() => assertSafeUrl('http://localhost/shop'), /not allowed|Invalid/);
    await assert.rejects(() => assertSafeUrl('https://127.0.0.1/'), /not allowed|private/);
  });

  it('assertSafeUrl rejects non-http protocols', async () => {
    await assert.rejects(() => assertSafeUrl('ftp://example.com'), /http\/https/);
  });

  it('extractBrandFromUrl parses theme-color and hex palette', async () => {
    const originalGet = require('axios').get;
    require('axios').get = async () => ({
      data: `
        <html>
          <head>
            <meta name="theme-color" content="#7C3AED" />
            <style>.btn{background:#5B21B6;color:#0F172A}</style>
            <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400&display=swap" rel="stylesheet" />
          </head>
        </html>
      `,
    });

    try {
      const kit = await extractBrandFromUrl('tenant_x', 'https://example-store.myshopify.com');
      assert.equal(kit.primary, '#7C3AED');
      assert.equal(kit.secondary, '#5B21B6');
      assert.equal(kit.fontFamily, 'Outfit');
      assert.equal(kit.confidence, 'high');
    } finally {
      require('axios').get = originalGet;
    }
  });
});
