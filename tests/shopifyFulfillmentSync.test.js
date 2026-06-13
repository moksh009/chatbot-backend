'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  pushOrderStatusToShopify,
  extractShopifyError,
  isLocalOnlyFallbackError,
} = require('../utils/shopify/shopifyFulfillmentSync');

function makeShopifyApi(handlers = {}) {
  const calls = [];
  const api = {
    calls,
    async get(path) {
      calls.push(['GET', path]);
      if (handlers.get?.[path]) return handlers.get[path]();
      throw new Error(`Unexpected GET ${path}`);
    },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (handlers.post?.[path]) return handlers.post[path](body);
      throw new Error(`Unexpected POST ${path}`);
    },
    async put(path, body) {
      calls.push(['PUT', path, body]);
      if (handlers.put?.[path]) return handlers.put[path](body);
      throw new Error(`Unexpected PUT ${path}`);
    },
  };
  return api;
}

describe('shopifyFulfillmentSync', () => {
  it('extractShopifyError parses errors object', () => {
    const err = { response: { data: { errors: 'Fulfillment order is closed' } } };
    assert.equal(extractShopifyError(err), 'Fulfillment order is closed');
  });

  it('isLocalOnlyFallbackError detects 422', () => {
    const err = { response: { status: 422, data: { errors: 'already fulfilled' } } };
    assert.equal(isLocalOnlyFallbackError(err), true);
  });

  it('pushOrderStatusToShopify — shipped uses fulfillment orders flow', async () => {
    const shopifyApi = makeShopifyApi({
      get: {
        '/orders/9001/fulfillment_orders.json': async () => ({
          data: { fulfillment_orders: [{ id: 55, status: 'open' }] },
        }),
        '/orders/9001/fulfillments.json': async () => ({ data: { fulfillments: [] } }),
      },
      post: {
        '/fulfillments.json': async () => ({
          data: { fulfillment: { id: 77, tracking_number: 'AWB1' } },
        }),
      },
    });

    const result = await pushOrderStatusToShopify({
      shopifyApi,
      shopifyOrderId: '9001',
      status: 'shipped',
      trackingNumber: 'AWB1',
      trackingUrl: 'https://track.example/AWB1',
    });

    assert.equal(result.ok, true);
    assert.ok(shopifyApi.calls.some((c) => c[0] === 'POST' && c[1] === '/fulfillments.json'));
  });

  it('pushOrderStatusToShopify — out_for_delivery posts fulfillment event', async () => {
    const shopifyApi = makeShopifyApi({
      get: {
        '/orders/9002/fulfillments.json': async () => ({
          data: { fulfillments: [{ id: 88, shipment_status: 'in_transit' }] },
        }),
        '/orders/9002/fulfillment_orders.json': async () => ({
          data: { fulfillment_orders: [] },
        }),
      },
      post: {
        '/orders/9002/fulfillments/88/events.json': async (body) => {
          assert.equal(body.event.status, 'out_for_delivery');
          return { data: {} };
        },
      },
    });

    const result = await pushOrderStatusToShopify({
      shopifyApi,
      shopifyOrderId: '9002',
      status: 'out_for_delivery',
    });

    assert.equal(result.ok, true);
  });

  it('pushOrderStatusToShopify — delivered posts delivered event', async () => {
    const shopifyApi = makeShopifyApi({
      get: {
        '/orders/9003/fulfillments.json': async () => ({
          data: { fulfillments: [{ id: 99, shipment_status: 'out_for_delivery' }] },
        }),
        '/orders/9003/fulfillment_orders.json': async () => ({
          data: { fulfillment_orders: [] },
        }),
      },
      post: {
        '/orders/9003/fulfillments/99/events.json': async (body) => {
          assert.equal(body.event.status, 'delivered');
          return { data: {} };
        },
      },
    });

    const result = await pushOrderStatusToShopify({
      shopifyApi,
      shopifyOrderId: '9003',
      status: 'delivered',
    });

    assert.equal(result.ok, true);
  });

  it('pushOrderStatusToShopify — cancelled calls cancel endpoint', async () => {
    const shopifyApi = makeShopifyApi({
      post: {
        '/orders/9004/cancel.json': async (body) => {
          assert.equal(body.reason, 'customer');
          return { data: {} };
        },
      },
    });

    const result = await pushOrderStatusToShopify({
      shopifyApi,
      shopifyOrderId: '9004',
      status: 'cancelled',
    });

    assert.equal(result.ok, true);
  });

  it('pushOrderStatusToShopify — confirmed skips financial mutation', async () => {
    const shopifyApi = makeShopifyApi({
      get: {
        '/orders/9005.json': async () => ({
          data: { order: { financial_status: 'pending', total_price: '999.00', currency: 'INR' } },
        }),
      },
    });

    const result = await pushOrderStatusToShopify({
      shopifyApi,
      shopifyOrderId: '9005',
      status: 'confirmed',
    });

    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.ok(!shopifyApi.calls.some((c) => c[0] === 'POST' && String(c[1]).includes('transactions')));
  });

  it('pushOrderStatusToShopify — returns allowLocalFallback on 422', async () => {
    const shopifyApi = makeShopifyApi({
      get: {
        '/orders/9006/fulfillments.json': async () => ({ data: { fulfillments: [] } }),
        '/orders/9006/fulfillment_orders.json': async () => {
          const err = new Error('Shopify 422');
          err.response = { status: 422, data: { errors: 'already fulfilled' } };
          throw err;
        },
      },
    });

    const result = await pushOrderStatusToShopify({
      shopifyApi,
      shopifyOrderId: '9006',
      status: 'shipped',
    });

    assert.equal(result.ok, false);
    assert.equal(result.allowLocalFallback, true);
    assert.match(result.error, /already fulfilled/i);
  });
});
