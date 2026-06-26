'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapOrderToVariables,
  mapRestOrderDataToVariables,
} = require('../../utils/commerce/orderLookupService');

test('mapOrderToVariables maps GraphQL fulfillments array (not connection nodes)', () => {
  const vars = mapOrderToVariables({
    name: '#1042',
    createdAt: '2026-01-15T10:00:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    totalPriceSet: {
      presentmentMoney: { amount: '1999.00', currencyCode: 'INR' },
    },
    shippingAddress: { formatted: ['12 MG Road', 'Ahmedabad', 'Gujarat'] },
    lineItems: {
      nodes: [{ title: 'Smart Watch', quantity: 1 }],
    },
    fulfillments: [
      {
        displayStatus: 'IN_TRANSIT',
        status: 'SUCCESS',
        trackingInfo: [{ company: 'Delhivery', number: 'DL123456789' }],
      },
    ],
  });

  assert.equal(vars.order_id, '#1042');
  assert.equal(vars.payment_status, 'PAID');
  assert.equal(vars.fulfillment_status, 'FULFILLED');
  assert.equal(vars.delivery_status, 'DL123456789');
  assert.match(vars.ordered_items, /Smart Watch/);
  assert.match(vars.order_total, /INR/);
});

test('mapOrderToVariables returns NA delivery_status when no fulfillments', () => {
  const vars = mapOrderToVariables({
    name: '#99',
    lineItems: { nodes: [] },
    fulfillments: [],
  });
  assert.equal(vars.delivery_status, 'NA');
});

test('mapRestOrderDataToVariables maps REST orderData to flow variables', () => {
  const vars = mapRestOrderDataToVariables(
    {
      orderNumber: '#1042',
      orderId: 'gid://shopify/Order/1',
      status: 'fulfilled',
      totalPrice: '1999.00',
      currency: 'INR',
      itemsSummary: '• Smart Watch × 1',
      trackingUrl: 'https://track.example/abc',
    },
    { order_number: '#1042' }
  );

  assert.equal(vars.order_id, '#1042');
  assert.equal(vars.ordered_items, '• Smart Watch × 1');
  assert.match(vars.order_total, /1999.00 INR/);
  assert.equal(vars.delivery_status, 'NA');
  assert.equal(vars.tracking_link, 'https://track.example/abc');
});

test('mapOrderToVariables maps tracking_link from GraphQL trackingInfo.url', () => {
  const vars = mapOrderToVariables({
    name: '#1042',
    fulfillments: [
      {
        trackingInfo: [{ url: 'https://track.example/xyz', number: 'DL999' }],
      },
    ],
    lineItems: { nodes: [] },
  });
  assert.equal(vars.tracking_link, 'https://track.example/xyz');
  assert.equal(vars.delivery_status, 'DL999');
});

test('fetchLatestOrderForFlow returns lookupFailed when client missing', async () => {
  const { fetchLatestOrderForFlow } = require('../../utils/commerce/orderLookupService');
  const result = await fetchLatestOrderForFlow({ client: null, phone: '+919876543210' });
  assert.equal(result.found, false);
  assert.equal(result.lookupFailed, true);
  assert.equal(result.apiError, 'missing_client');
});
