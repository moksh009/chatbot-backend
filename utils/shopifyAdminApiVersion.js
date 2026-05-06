"use strict";

/**
 * Single source for Shopify Admin REST API version used in outbound calls and webhook registration.
 * Override with SHOPIFY_ADMIN_API_VERSION or SHOPIFY_API_VERSION (same value).
 */
module.exports =
  process.env.SHOPIFY_ADMIN_API_VERSION ||
  process.env.SHOPIFY_API_VERSION ||
  "2026-04";
