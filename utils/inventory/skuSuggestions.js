'use strict';

const ShopifyProduct = require('../../models/ShopifyProduct');
const SkuMapping = require('../../models/SkuMapping');

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function normalizeSku(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[-_\s]/g, '');
}

/**
 * Suggest Shopify catalog matches for an unmapped Amazon seller SKU.
 */
async function suggestMappings(clientId, amazonSellerSku, { limit = 5 } = {}) {
  const catalog = await ShopifyProduct.find({ clientId, sku: { $ne: '' } })
    .select('sku title shopifyProductId shopifyVariantId')
    .lean();
  const mapped = new Set(
    (await SkuMapping.find({ clientId }).select('internalSku shopify.amazon.sellerSku').lean()).map(
      (m) => m.internalSku
    )
  );

  const target = normalizeSku(amazonSellerSku);
  const scored = [];

  for (const row of catalog) {
    if (!row.sku || mapped.has(row.sku)) continue;
    const n = normalizeSku(row.sku);
    let score = 0;
    if (n === target) score = 100;
    else if (n.includes(target) || target.includes(n)) score = 75;
    else {
      const dist = levenshtein(n, target);
      if (dist <= 3) score = Math.max(40, 90 - dist * 15);
    }
    if (score > 0) {
      scored.push({
        internalSku: row.sku,
        shopify: {
          productId: row.shopifyProductId,
          variantId: row.shopifyVariantId,
          sku: row.sku,
        },
        title: row.title,
        confidence: score,
        reason: score >= 95 ? 'exact' : score >= 75 ? 'substring' : 'fuzzy',
      });
    }
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  return scored.slice(0, limit);
}

async function listUnmappedSkus(clientId) {
  const products = await ShopifyProduct.find({ clientId, sku: { $ne: '' } })
    .select('sku title shopifyVariantId inventoryQuantity')
    .lean();
  const mappings = await SkuMapping.find({ clientId }).select('internalSku shopify.sku amazon.sellerSku').lean();
  const mappedShopify = new Set();
  const mappedAmazon = new Set();
  for (const m of mappings) {
    if (m.shopify?.sku) mappedShopify.add(m.shopify.sku);
    if (m.internalSku) mappedShopify.add(m.internalSku);
    if (m.amazon?.sellerSku) mappedAmazon.add(m.amazon.sellerSku);
  }

  const shopifyOnly = products
    .filter((p) => !mappedShopify.has(p.sku))
    .map((p) => ({ type: 'shopify_only', sku: p.sku, title: p.title, qty: p.inventoryQuantity }));

  return {
    shopifyOnly,
    amazonOnly: [],
    unmappedShopifyCount: shopifyOnly.length,
    mappedAmazonSkus: [...mappedAmazon],
  };
}

module.exports = { suggestMappings, listUnmappedSkus, levenshtein, normalizeSku };
