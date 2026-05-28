'use strict';

const DEFAULT_APP_SCOPES =
  'read_products,write_products,read_orders,write_orders,read_customers,write_customers,read_checkouts,write_checkouts,read_themes,write_themes,read_price_rules,write_price_rules,read_discounts,write_discounts,read_shopify_payments_payouts,write_pixels,read_customer_events';

const PIXEL_SCOPE_KEYS = ['write_pixels', 'read_customer_events'];

function parseShopifyScopes(scopesRaw) {
  if (!scopesRaw) return [];
  if (Array.isArray(scopesRaw)) {
    return scopesRaw.map((s) => String(s).trim()).filter(Boolean);
  }
  return String(scopesRaw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function getShopifyAppConfiguredScopes() {
  return parseShopifyScopes(process.env.SHOPIFY_SCOPES || DEFAULT_APP_SCOPES);
}

function hasPixelScopes(scopesRaw) {
  const granted = parseShopifyScopes(scopesRaw);
  return PIXEL_SCOPE_KEYS.every((key) => granted.includes(key));
}

function buildScopeSummary(scopesRaw) {
  const granted = parseShopifyScopes(scopesRaw);
  const appConfigured = getShopifyAppConfiguredScopes();
  return {
    granted,
    appConfigured,
    hasPixelScopes: hasPixelScopes(granted),
    missingFromGrant: PIXEL_SCOPE_KEYS.filter((k) => !granted.includes(k)),
    pixelScopeKeys: PIXEL_SCOPE_KEYS,
  };
}

module.exports = {
  PIXEL_SCOPE_KEYS,
  parseShopifyScopes,
  getShopifyAppConfiguredScopes,
  hasPixelScopes,
  buildScopeSummary,
};
