'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const {
  enrichLineItemsWithImages,
  normalizeIncomingCartItems,
} = require('../../utils/commerce/upsertAbandonedCartLead');
const { buildCartRecoveryComponents } = require('../../utils/commerce/buildCartRecoveryComponents');

const originalGet = axios.get;

test('normalizeIncomingCartItems preserves product_id and image_url', () => {
  const items = normalizeIncomingCartItems([
    {
      product_id: 123,
      variant_id: 456,
      title: 'Watch',
      image_url: 'https://cdn.example/watch.jpg',
      quantity: 2,
      price: '999',
    },
  ]);
  assert.equal(items[0].product_id, 123);
  assert.equal(items[0].image, 'https://cdn.example/watch.jpg');
});

test('enrichLineItemsWithImages fetches product image from Shopify Admin API', async (t) => {
  t.after(() => {
    axios.get = originalGet;
  });

  axios.get = async (url) => {
    assert.match(url, /\/products\/777\.json$/);
    return { data: { product: { images: [{ src: 'https://cdn.shopify.com/product.jpg' }] } } };
  };

  const client = { shopDomain: 'demo.myshopify.com', shopifyAccessToken: 'shpat_test' };
  const [item] = await enrichLineItemsWithImages([{ product_id: 777, title: 'Doorbell' }], client);

  assert.equal(item.image, 'https://cdn.shopify.com/product.jpg');
  assert.equal(item.image_url, 'https://cdn.shopify.com/product.jpg');
  assert.equal(item.product_id, '777');
});

test('enriched cart snapshot image flows into cart recovery header', async (t) => {
  t.after(() => {
    axios.get = originalGet;
  });

  axios.get = async () => ({
    data: { product: { images: [{ src: 'https://cdn.shopify.com/header.jpg' }] } },
  });

  const client = { shopDomain: 'demo.myshopify.com', shopifyAccessToken: 'token' };
  const [item] = await enrichLineItemsWithImages([{ product_id: 1, title: 'Shoes' }], client);
  const lead = {
    firstName: 'Asha',
    cartSnapshot: { items: [item], total_price: 1200 },
    checkoutUrl: 'https://demo.myshopify.com/cart/recover/abc',
  };

  const { components } = buildCartRecoveryComponents(lead, client, 1);
  assert.equal(components[0].type, 'header');
  assert.equal(components[0].parameters[0].image.link, 'https://cdn.shopify.com/header.jpg');
});

test('enrichLineItemsWithImages skips API when image already on payload', async (t) => {
  t.after(() => {
    axios.get = originalGet;
  });

  let called = false;
  axios.get = async () => {
    called = true;
    return { data: {} };
  };

  const client = { shopDomain: 'demo.myshopify.com', shopifyAccessToken: 'token' };
  const [item] = await enrichLineItemsWithImages(
    [{ product_id: 1, title: 'Hat', image_url: 'https://cdn.example/hat.png' }],
    client
  );

  assert.equal(called, false);
  assert.equal(item.image, 'https://cdn.example/hat.png');
});
