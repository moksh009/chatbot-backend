'use strict';

/**
 * Topics registered after OAuth / connect so `/api/shopify/webhook` receives
 * fulfillment + order updates (tracking, status). Scopes: read_orders is enough;
 * no extra OAuth scope is required for these webhook topics.
 *
 * @see https://shopify.dev/docs/api/admin-rest/latest/resources/webhook
 */
const SHOPIFY_APP_WEBHOOK_TOPICS = [
  'checkouts/create',
  'checkouts/update',
  'orders/create',
  'orders/updated',
  'orders/fulfilled',
  'orders/cancelled',
  'fulfillments/create',
  'fulfillments/update',
];

module.exports = { SHOPIFY_APP_WEBHOOK_TOPICS };
