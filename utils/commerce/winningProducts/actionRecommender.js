'use strict';

const { CLASSIFICATIONS } = require('./storyClassifier');

function shopifyProductUrl(shopDomain, productId, handle) {
  if (!shopDomain) return null;
  const domain = shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const h = handle || (String(productId || '').startsWith('handle:') ? productId.slice(7) : '');
  if (!h) return `https://${domain}/admin/products`;
  return `https://${domain}/admin/products/${encodeURIComponent(h)}`;
}

function recommendActions({ product, classification, bottleneck, shopDomain, retargetableCount }) {
  const handle = product?.handle || '';
  const productId = product?.productId || '';
  const shopifyUrl = shopifyProductUrl(shopDomain, productId, handle);

  const baseShopify = shopifyUrl
    ? { label: 'View on Shopify', type: 'shopify', link: shopifyUrl, primary: false }
    : null;

  switch (classification) {
    case CLASSIFICATIONS.WINNING:
      return [
        {
          label: 'Promote',
          type: 'campaign',
          link: '/marketing-hub',
          primary: true,
        },
        ...(baseShopify ? [{ ...baseShopify, primary: false }] : []),
        {
          label: 'Promote on WhatsApp',
          type: 'recover',
          link: '/marketing-hub',
          primary: false,
        },
      ];

    case CLASSIFICATIONS.RISING:
      return [
        {
          label: 'Feature on homepage',
          type: 'homepage',
          link: shopifyUrl || '/commerce-hub?tab=products',
          primary: true,
        },
        {
          label: 'Save for future ads',
          type: 'audience',
          link: '/audiences-queue',
          primary: false,
        },
      ];

    case CLASSIFICATIONS.STALLED:
      return [
        {
          label: 'Diagnose',
          type: 'analyze',
          link: shopifyUrl || '/commerce-hub?tab=product_insights',
          primary: true,
        },
        {
          label: 'Run cart recovery WhatsApp',
          type: 'recover',
          link: '/audience-hub?tab=cart-recovery',
          primary: false,
        },
        {
          label: 'Try a discount',
          type: 'discount',
          link: '/marketing-hub',
          primary: false,
        },
      ];

    case CLASSIFICATIONS.DYING:
      return [
        {
          label: 'Review',
          type: 'shopify',
          link: shopifyUrl || '/commerce-hub?tab=products',
          primary: true,
        },
        {
          label: 'Investigate',
          type: 'analyze',
          link: '/commerce-hub?tab=product_insights',
          primary: false,
        },
      ];

    case CLASSIFICATIONS.INSUFFICIENT_DATA:
      return [
        {
          label: 'Fix tracking',
          type: 'tracking',
          link: '/commerce-hub?tab=tracking',
          primary: true,
        },
        ...(baseShopify ? [baseShopify] : []),
      ];

    case CLASSIFICATIONS.NO_ACTIVITY:
      return baseShopify ? [baseShopify] : [];

    default:
      return baseShopify ? [{ ...baseShopify, primary: true }] : [];
  }
}

module.exports = { recommendActions, shopifyProductUrl };
