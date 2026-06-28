'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapOrderToVariables,
  mapRestOrderDataToVariables,
  mapShopifyRestOrderToVariables,
  mapLocalOrderToVariables,
  normalizePhoneE164ForShopifyQuery,
  buildShopifyCustomerPhoneQuery,
} = require('../../utils/commerce/orderLookupService');

test('normalizePhoneE164ForShopifyQuery strips formatting and prepends +', () => {
  assert.equal(normalizePhoneE164ForShopifyQuery('+919484607042'), '+919484607042');
  assert.equal(normalizePhoneE164ForShopifyQuery('919484607042'), '+919484607042');
  assert.equal(normalizePhoneE164ForShopifyQuery('(91) 94846-07042'), '+919484607042');
  assert.equal(normalizePhoneE164ForShopifyQuery(''), '');
});

test('buildShopifyCustomerPhoneQuery binds E.164 to Shopify search', () => {
  assert.equal(
    buildShopifyCustomerPhoneQuery('+919484607042'),
    'phone:+919484607042'
  );
});

test('mapOrderToVariables maps GraphQL lastOrder with fulfillments.nodes + trackingInfo', () => {
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
    fulfillments: {
      nodes: [
        {
          trackingInfo: [{ status: 'IN_TRANSIT', url: 'https://track.example/abc' }],
        },
      ],
    },
  });

  assert.equal(vars.order_id, '#1042');
  assert.equal(vars.payment_status, 'PAID');
  assert.equal(vars.fulfillment_status, 'FULFILLED');
  assert.equal(vars.delivery_status, 'IN_TRANSIT');
  assert.equal(vars.tracking_link, 'https://track.example/abc');
  assert.equal(vars.ordered_items, 'Smart Watchx 1');
  assert.match(vars.order_total, /1999.00 INR/);
  assert.equal(vars.shipping_address, '12 MG Road, Ahmedabad, Gujarat');
  assert.match(vars.order_date, /2026/);
});

test('mapOrderToVariables returns NA delivery_status when fulfillments empty', () => {
  const vars = mapOrderToVariables({
    name: '#99',
    lineItems: { nodes: [] },
    fulfillments: { nodes: [] },
  });
  assert.equal(vars.delivery_status, 'NA');
  assert.equal(vars.tracking_link, 'NA');
});

test('mapRestOrderDataToVariables maps REST orderData to flow variables', () => {
  const vars = mapRestOrderDataToVariables(
    {
      orderNumber: '#1042',
      orderId: 'gid://shopify/Order/1',
      status: 'fulfilled',
      financialStatus: 'paid',
      fulfillmentStatus: 'fulfilled',
      totalPrice: '1999.00',
      currency: 'INR',
      itemsSummary: 'Smart Watchx 2',
      trackingUrl: 'https://track.example/abc',
      createdAt: '2026-01-15T10:00:00Z',
      shippingAddress: '12 MG Road, Mumbai',
    },
    { order_number: '#1042' }
  );

  assert.equal(vars.order_id, '#1042');
  assert.equal(vars.ordered_items, 'Smart Watchx 2');
  assert.match(vars.order_total, /1999.00 INR/);
  assert.equal(vars.payment_status, 'PAID');
  assert.equal(vars.fulfillment_status, 'FULFILLED');
  assert.match(vars.order_date, /2026/);
  assert.equal(vars.shipping_address, '12 MG Road, Mumbai');
  assert.equal(vars.tracking_link, 'https://track.example/abc');
});

test('mapShopifyRestOrderToVariables maps full Shopify REST order JSON', () => {
  const vars = mapShopifyRestOrderToVariables({
    name: '#1006',
    order_number: 1006,
    created_at: '2026-03-10T08:30:00Z',
    financial_status: 'paid',
    fulfillment_status: 'fulfilled',
    total_price: '1499.90',
    currency: 'INR',
    shipping_address: {
      address1: '12 MG Road',
      city: 'Mumbai',
      province: 'Maharashtra',
      zip: '400001',
      country: 'India',
    },
    line_items: [{ title: 'The Collection Snowboard: Liquid', quantity: 2 }],
    fulfillments: [
      {
        shipment_status: 'in_transit',
        tracking_number: 'DL123456789',
        tracking_url: 'https://track.example/abc',
      },
    ],
  });

  assert.equal(vars.order_id, '#1006');
  assert.match(vars.order_date, /Mar|03/);
  assert.equal(vars.ordered_items, 'The Collection Snowboard: Liquidx 2');
  assert.equal(vars.order_total, '1499.90 INR');
  assert.match(vars.shipping_address, /MG Road/);
  assert.equal(vars.payment_status, 'PAID');
  assert.equal(vars.fulfillment_status, 'FULFILLED');
  assert.equal(vars.delivery_status, 'in transit');
  assert.equal(vars.tracking_link, 'https://track.example/abc');
});

test('mapLocalOrderToVariables maps Mongo order document', () => {
  const vars = mapLocalOrderToVariables({
    orderNumber: '#1042',
    createdAt: new Date('2026-02-01T12:00:00Z'),
    totalPrice: 1999,
    currency: 'INR',
    financialStatus: 'paid',
    fulfillmentStatus: 'fulfilled',
    address: 'MG Road, Mumbai',
    trackingUrl: 'https://track.example/x',
    lastShipmentStatus: 'delivered',
    items: [{ name: 'Smart Watch', quantity: 1 }],
  });

  assert.equal(vars.order_id, '#1042');
  assert.equal(vars.payment_status, 'PAID');
  assert.equal(vars.fulfillment_status, 'FULFILLED');
  assert.equal(vars.delivery_status, 'delivered');
  assert.equal(vars.ordered_items, 'Smart Watchx 1');
});

test('mapOrderToVariables maps tracking_link from GraphQL trackingInfo connection nodes', () => {
  const vars = mapOrderToVariables({
    name: '#1042',
    fulfillments: {
      nodes: [
        {
          trackingInfo: {
            nodes: [{ url: 'https://track.example/xyz', status: 'DELIVERED' }],
          },
        },
      ],
    },
    lineItems: { nodes: [] },
  });
  assert.equal(vars.tracking_link, 'https://track.example/xyz');
  assert.equal(vars.delivery_status, 'DELIVERED');
});

test('fetchLatestOrderForFlow returns lookupFailed when client missing', async () => {
  const { fetchLatestOrderForFlow } = require('../../utils/commerce/orderLookupService');
  const result = await fetchLatestOrderForFlow({ client: null, phone: '+919876543210' });
  assert.equal(result.found, false);
  assert.equal(result.lookupFailed, true);
  assert.equal(result.apiError, 'missing_client');
});
