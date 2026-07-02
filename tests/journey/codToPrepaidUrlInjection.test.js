'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { injectWaClickTrackingUrl } = require('../../services/journeyBuilder/journeySequenceWhatsApp');

describe('Part 5 — static URL button injection for COD prepaid', () => {
  it('appends button component with sub_type url, index, and invoice URL parameter', () => {
    const templateComponents = [
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Pay Now', url: 'https://example.com/checkout' },
        ],
      },
    ];

    const components = injectWaClickTrackingUrl(
      [],
      {
        hasUrlButton: true,
        urlButtonDestination: 'https://shop.myshopify.com/invoices/abc123',
        stepIndex: 0,
      },
      'client_1',
      'seq_99',
      templateComponents
    );

    assert.equal(components.length, 1);
    assert.equal(components[0].type, 'button');
    assert.equal(components[0].sub_type, 'url');
    assert.equal(components[0].index, '0');
    assert.deepEqual(components[0].parameters, [
      {
        type: 'text',
        text: components[0].parameters[0].text,
      },
    ]);
    assert.match(components[0].parameters[0].text, /invoices\/abc123|wa-click|track/i);
  });

  it('overrides existing dynamic URL button parameters with checkout destination', () => {
    const components = injectWaClickTrackingUrl(
      [
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: 'https://old.example' }],
        },
      ],
      {
        hasUrlButton: true,
        urlButtonDestination: 'https://shop.myshopify.com/invoices/xyz',
        stepIndex: 1,
      },
      'client_1',
      'seq_1',
      []
    );

    assert.equal(components[0].parameters[0].type, 'text');
    assert.notEqual(components[0].parameters[0].text, 'https://old.example');
  });

  it('injects only the first static URL button when multiple URL buttons exist', () => {
    const templateComponents = [
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Pay Now', url: 'https://example.com/checkout' },
          { type: 'URL', text: 'Track', url: 'https://example.com/track' },
        ],
      },
    ];

    const components = injectWaClickTrackingUrl(
      [],
      {
        hasUrlButton: true,
        urlButtonDestination: 'https://shop.myshopify.com/invoices/abc123',
        stepIndex: 0,
      },
      'client_1',
      'seq_99',
      templateComponents
    );

    assert.equal(components.length, 1);
    assert.equal(components[0].index, '0');
  });
});
