'use strict';

/** Canonical OAuth scopes — must match Partner app + SHOPIFY_SCOPES in .env (do not paste full Partner catalog). */
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

/** Scopes the TopEdge app requests at install — fixed list for UI + OAuth fallback. */
function getShopifyAppConfiguredScopes() {
  return parseShopifyScopes(REQUIRED_APP_SCOPES_CSV);
}

/** CSV for Shopify OAuth authorize URL (env allowed if trimmed; never Partner catalog dump). */
function getShopifyOAuthScopeCsv() {
  const canonical = getShopifyAppConfiguredScopes();
  const fromEnv = parseShopifyScopes(process.env.SHOPIFY_SCOPES);
  if (!fromEnv.length) return canonical.join(',');
  if (fromEnv.length > canonical.length + 5) {
    console.warn(
      `[shopifyScopeUtils] SHOPIFY_SCOPES has ${fromEnv.length} entries; OAuth uses canonical ${canonical.length} scopes. Trim .env to REQUIRED_APP_SCOPES only.`
    );
    return canonical.join(',');
  }
  const allowed = new Set(canonical);
  const trimmed = fromEnv.filter((s) => allowed.has(s));
  return (trimmed.length ? trimmed : canonical).join(',');
}

function hasPixelScopes(scopesRaw) {
  const granted = parseShopifyScopes(scopesRaw);
  return PIXEL_SCOPE_KEYS.every((key) => granted.includes(key));
}

function buildScopeSummary(scopesRaw) {
  const granted = parseShopifyScopes(scopesRaw);
  const appConfigured = getShopifyAppConfiguredScopes();
  const missingFromGrant = appConfigured.filter((s) => !granted.includes(s));
  return {
    granted,
    appConfigured,
    hasPixelScopes: hasPixelScopes(granted),
    missingFromGrant,
    missingPixelScopes: PIXEL_SCOPE_KEYS.filter((k) => !granted.includes(k)),
    pixelScopeKeys: PIXEL_SCOPE_KEYS,
  };
}

module.exports = {
  PIXEL_SCOPE_KEYS,
  REQUIRED_APP_SCOPES_CSV,
  parseShopifyScopes,
  getShopifyAppConfiguredScopes,
  getShopifyOAuthScopeCsv,
  hasPixelScopes,
  buildScopeSummary,
};
