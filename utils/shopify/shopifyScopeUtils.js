'use strict';

/**
 * SINGLE SOURCE OF TRUTH for Shopify OAuth scopes.
 * Any change here MUST be reflected in:
 *   1. shopify.app.toml (monorepo root — canonical for Shopify CLI)
 *   2. Shopify Partner Dashboard (via `shopify app deploy`)
 *   3. Frontend mirror: src/utils/shopifyScopes.js
 */
const REQUIRED_APP_SCOPES_CSV =
  'read_products,write_products,read_orders,write_orders,read_customers,write_customers,read_checkouts,write_checkouts,read_themes,write_themes,read_price_rules,write_price_rules,read_discounts,write_discounts,read_shopify_payments_payouts,read_inventory,write_inventory,read_locations,write_draft_orders,read_pixels,write_pixels,read_customer_events';

const PIXEL_SCOPE_KEYS = ['read_pixels', 'write_pixels', 'read_customer_events'];

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

/**
 * Expand a granted scope list to include implied read scopes.
 * Shopify rule: write_X implies read_X. When both read_X and write_X are
 * requested, OAuth response only returns write_X — the read is omitted.
 * This function materializes the implied reads so comparisons work correctly.
 */
function expandImpliedScopes(scopes) {
  const expanded = new Set(scopes);
  for (const s of scopes) {
    if (s.startsWith('write_')) {
      expanded.add('read_' + s.slice(6));
    }
  }
  return [...expanded];
}

/** Scopes the TopEdge app requests at install — fixed list for UI + OAuth fallback. */
function getShopifyAppConfiguredScopes() {
  return parseShopifyScopes(REQUIRED_APP_SCOPES_CSV);
}

/** CSV for Shopify OAuth authorize URL. Always uses canonical list. */
function getShopifyOAuthScopeCsv() {
  return getShopifyAppConfiguredScopes().join(',');
}

function hasPixelScopes(scopesRaw) {
  const granted = expandImpliedScopes(parseShopifyScopes(scopesRaw));
  return PIXEL_SCOPE_KEYS.every((key) => granted.includes(key));
}

/**
 * Build scope summary with write-implies-read expansion.
 * effectiveGranted = raw granted + implied reads from writes.
 * missingFromGrant = required scopes NOT covered even after expansion.
 */
function buildScopeSummary(scopesRaw) {
  const rawGranted = parseShopifyScopes(scopesRaw);
  const effectiveGranted = expandImpliedScopes(rawGranted);
  const appConfigured = getShopifyAppConfiguredScopes();
  const missingFromGrant = appConfigured.filter((s) => !effectiveGranted.includes(s));
  return {
    granted: rawGranted,
    effectiveGranted,
    appConfigured,
    hasPixelScopes: hasPixelScopes(scopesRaw),
    missingFromGrant,
    missingPixelScopes: PIXEL_SCOPE_KEYS.filter((k) => !effectiveGranted.includes(k)),
    pixelScopeKeys: PIXEL_SCOPE_KEYS,
    isFullyAuthorized: missingFromGrant.length === 0,
  };
}

/**
 * Check if a specific scope is effectively granted (accounting for write→read).
 */
function hasScopeEffective(scopesRaw, scope) {
  const effective = expandImpliedScopes(parseShopifyScopes(scopesRaw));
  return effective.includes(scope);
}

module.exports = {
  PIXEL_SCOPE_KEYS,
  REQUIRED_APP_SCOPES_CSV,
  parseShopifyScopes,
  expandImpliedScopes,
  getShopifyAppConfiguredScopes,
  getShopifyOAuthScopeCsv,
  hasPixelScopes,
  hasScopeEffective,
  buildScopeSummary,
};
