'use strict';

const axios = require('axios');
const shopifyAdminApiVersion = require('../shopify/shopifyAdminApiVersion');

/**
 * Enrich Shopify line items with product images (checkout + order payloads).
 */
async function enrichLineItemsForCommerce(client, lineItems = []) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const token = client?.shopifyAccessToken;
  const shopDomain = client?.shopDomain
    ? String(client.shopDomain).replace(/^https?:\/\//, '').split('/')[0]
    : '';

  return Promise.all(
    items.map(async (item) => {
      let imageUrl = item.image_url || item.imageUrl || item.image?.src || null;
      if (!imageUrl && item.product_id && token && shopDomain) {
        try {
          const res = await axios.get(
            `https://${shopDomain}/admin/api/${shopifyAdminApiVersion}/products/${item.product_id}.json`,
            { headers: { 'X-Shopify-Access-Token': token }, timeout: 8000 }
          );
          imageUrl = res.data.product?.images?.[0]?.src || null;
        } catch (_) {
          /* omit — header falls back to brand logo */
        }
      }
      const title = item.title || item.name || 'Item';
      const qty = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
      return {
        title,
        quantity: qty,
        price: item.price || item.line_price || '',
        imageUrl,
        variant_title: item.variant_title || '',
        sku: item.sku || '',
        product_id: item.product_id,
      };
    })
  );
}

/** Multi-line bullet list (email / metadata). */
function formatLineItemsBullets(enriched = []) {
  if (!enriched.length) return '';
  return enriched
    .map((i) => `• ${i.title}${i.variant_title ? ` (${i.variant_title})` : ''} × ${i.quantity}`)
    .join('\n');
}

/** Single-line summary for WhatsApp template body variables. */
function formatLineItemsSummary(enriched = []) {
  if (!enriched.length) return '';
  return enriched
    .map((i) => `${i.title}${i.variant_title ? ` (${i.variant_title})` : ''} × ${i.quantity}`)
    .join(', ');
}

module.exports = {
  enrichLineItemsForCommerce,
  formatLineItemsBullets,
  formatLineItemsSummary,
};
