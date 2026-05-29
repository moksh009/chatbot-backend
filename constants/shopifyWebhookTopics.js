'use strict';

/**
 * Webhook topics with their required scopes.
 * Registration skips topics whose required scope isn't granted.
 * @see https://shopify.dev/docs/api/admin-rest/latest/resources/webhook
 */
const SHOPIFY_WEBHOOK_TOPICS_WITH_SCOPES = [
  { topic: 'checkouts/create', requiredScope: 'read_checkouts' },
  { topic: 'checkouts/update', requiredScope: 'read_checkouts' },
  { topic: 'orders/create', requiredScope: 'read_orders' },
  { topic: 'orders/updated', requiredScope: 'read_orders' },
  { topic: 'orders/fulfilled', requiredScope: 'read_orders' },
  { topic: 'orders/cancelled', requiredScope: 'read_orders' },
  { topic: 'fulfillments/create', requiredScope: 'read_orders' },
  { topic: 'fulfillments/update', requiredScope: 'read_orders' },
  { topic: 'products/create', requiredScope: 'read_products' },
  { topic: 'products/update', requiredScope: 'read_products' },
  { topic: 'customers/create', requiredScope: 'read_customers' },
  { topic: 'customers/update', requiredScope: 'read_customers' },
  { topic: 'app/uninstalled', requiredScope: null },
];

const SHOPIFY_APP_WEBHOOK_TOPICS = SHOPIFY_WEBHOOK_TOPICS_WITH_SCOPES.map((t) => t.topic);

module.exports = { SHOPIFY_APP_WEBHOOK_TOPICS, SHOPIFY_WEBHOOK_TOPICS_WITH_SCOPES };
