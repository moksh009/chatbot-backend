'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateTemplateEligibility,
  getUrlButtonVariableCount,
} = require('../../utils/meta/templateEligibility');

test('getUrlButtonVariableCount detects dynamic URL buttons', () => {
  const count = getUrlButtonVariableCount({
    name: 'promo',
    components: [
      {
        type: 'BUTTONS',
        buttons: [{ type: 'URL', url: 'https://shop.example/{{1}}' }],
      },
    ],
  });
  assert.equal(count, 1);
});

test('validateTemplateEligibility fails when URL button lacks store context', () => {
  const result = validateTemplateEligibility({
    template: {
      name: '3mp_final',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Hello {{1}}' },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'URL', url: 'https://shop.example/{{1}}' }],
        },
      ],
    },
    contextPurpose: 'campaign',
    providedVariables: ['Customer'],
    strict: true,
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes('URL button')));
});

test('validateTemplateEligibility passes URL button when store URL provided', () => {
  const result = validateTemplateEligibility({
    template: {
      name: '3mp_final',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Hello {{1}}' },
        {
          type: 'BUTTONS',
          buttons: [{ type: 'URL', url: 'https://shop.example/{{1}}' }],
        },
      ],
    },
    contextPurpose: 'campaign',
    providedVariables: ['Customer'],
    contextUrls: { checkout_url: 'https://shop.example' },
    strict: true,
  });
  assert.equal(result.ok, true);
});
