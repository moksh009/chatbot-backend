'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  templateHasCheckoutUrlButton,
  templateHasStaticUrlButton,
  isUrlTypeButton,
} = require('../../utils/meta/codPrepaidTemplateEligibility');

describe('codPrepaidTemplateEligibility', () => {
  it('accepts dynamic checkout URL buttons (urlVariable)', () => {
    const tpl = {
      components: [{
        type: 'BUTTONS',
        buttons: [{ type: 'URL', text: 'Buy now', urlVariable: 'checkout_url' }],
      }],
    };
    assert.equal(templateHasCheckoutUrlButton(tpl), true);
    assert.equal(templateHasStaticUrlButton(tpl), false);
  });

  it('accepts static placeholder URL buttons', () => {
    const tpl = {
      formData: {
        buttons: [{
          buttonType: 'URL',
          text: 'Pay now',
          url: 'https://checkout.example.com/cart',
          urlType: 'Static',
        }],
      },
    };
    assert.equal(templateHasCheckoutUrlButton(tpl), true);
    assert.equal(templateHasStaticUrlButton(tpl), true);
  });

  it('rejects quick-reply-only templates like eco_cod_prepaid_switch', () => {
    const tpl = {
      components: [{
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Pay via UPI Now' },
          { type: 'QUICK_REPLY', text: 'Keep COD' },
        ],
      }],
    };
    assert.equal(templateHasCheckoutUrlButton(tpl), false);
  });

  it('accepts Meta dynamic URL pattern {{1}}', () => {
    const btn = { type: 'URL', text: 'Buy now', url: 'https://shop.example/{{1}}' };
    assert.equal(isUrlTypeButton(btn), true);
    assert.equal(templateHasCheckoutUrlButton({ components: [{ type: 'BUTTONS', buttons: [btn] }] }), true);
  });
});
