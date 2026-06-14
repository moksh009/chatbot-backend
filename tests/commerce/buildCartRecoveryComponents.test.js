'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildCartRecoveryComponents,
  pickBestCartItem,
  formatCartTotalINR,
  lineItemValue,
} = require('../../utils/commerce/buildCartRecoveryComponents');

describe('buildCartRecoveryComponents', () => {
  const client = {
    clientId: 'test-client',
    shopDomain: 'demo.myshopify.com',
    businessLogo: 'https://cdn.shop/logo.png',
  };

  const lead = {
    name: 'Priya Sharma',
    cartValue: 4999,
    cartSnapshot: {
      total_price: 4999,
      items: [
        {
          title: 'Cotton tee',
          price: 999,
          quantity: 1,
          image: 'http://insecure.example/tee.jpg',
        },
        {
          title: 'Linen co-ord set',
          price: 2499,
          quantity: 1,
          image: 'https://cdn.shop/linen.jpg',
        },
        {
          title: 'Socks pack',
          price: 499,
          quantity: 2,
          lineTotal: 998,
          image: 'https://cdn.shop/socks.jpg',
        },
      ],
    },
  };

  it('picks highest-value cart line for product name and image', () => {
    const best = pickBestCartItem(lead);
    assert.equal(best.title, 'Linen co-ord set');
    assert.equal(lineItemValue(best), 2499);
  });

  it('formats cart total in en-IN locale without rupee symbol', () => {
    assert.equal(formatCartTotalINR(4999), '4,999');
    assert.equal(formatCartTotalINR('₹2,499'), '2,499');
  });

  it('includes HTTPS product image header on all steps when enabled', () => {
    for (const step of [1, 2, 3]) {
      const { components, context } = buildCartRecoveryComponents(lead, client, step, {
        includeHeaderImage: true,
        discountCode: 'COMEBACK10',
        recoveryUrl: 'https://store.com/recover',
      });
      const header = components.find((c) => c.type === 'header');
      assert.ok(header, `step ${step} should have image header`);
      assert.equal(header.parameters[0].image.link, 'https://cdn.shop/linen.jpg');
      assert.equal(context.productName, 'Linen co-ord set');
      assert.equal(context.cartTotal, '4,999');
      const body = components.find((c) => c.type === 'body');
      assert.ok(body?.parameters?.length >= 2);
      if (step === 3) {
        assert.equal(body.parameters[3].text, 'COMEBACK10');
      }
    }
  });

  it('falls back to brand logo when line item has no HTTPS image', () => {
    const sparseLead = {
      name: 'Rahul',
      cartSnapshot: {
        items: [{ title: 'Only item', price: 1200, quantity: 1 }],
      },
    };
    const { components } = buildCartRecoveryComponents(sparseLead, client, 1);
    const header = components.find((c) => c.type === 'header');
    assert.ok(header);
    assert.equal(header.parameters[0].image.link, 'https://cdn.shop/logo.png');
  });
});
