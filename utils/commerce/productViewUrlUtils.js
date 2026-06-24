'use strict';

function extractProductPath(url) {
  if (!url) return null;
  const raw = String(url).trim();
  if (!raw.includes('/products/')) return null;

  try {
    if (raw.startsWith('/') && !raw.startsWith('//')) {
      return raw.split('?')[0].split('#')[0];
    }
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return new URL(raw).pathname;
    }
    const withProto = raw.includes('://') ? raw : `https://${raw.replace(/^\/+/, '')}`;
    return new URL(withProto).pathname;
  } catch {
    const slash = raw.indexOf('/products/');
    if (slash === -1) return null;
    return raw.slice(slash).split('?')[0].split('#')[0];
  }
}

function inferProductFromUrl(url) {
  const pathname = extractProductPath(url);
  if (!pathname) return null;
  const match = pathname.match(/\/products\/([^/?#]+)/);
  if (!match || !match[1]) return null;
  const handle = decodeURIComponent(match[1]);
  return {
    productId: `handle:${handle}`,
    handle,
    title: handle.replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
    image: '',
    price: 0,
    currency: 'INR',
  };
}

function isProductPageUrl(url) {
  return Boolean(inferProductFromUrl(url));
}

/** Mongo expression: event counts as a product view (explicit or product URL page_view). */
const PRODUCT_VIEW_MATCH_EXPR = {
  $or: [
    { $eq: ['$eventName', 'product_view'] },
    {
      $and: [
        { $eq: ['$eventName', 'page_view'] },
        {
          $or: [
            { $regexMatch: { input: { $ifNull: ['$url', ''] }, regex: /\/products\// } },
            { $regexMatch: { input: { $ifNull: ['$metadata.url', ''] }, regex: /\/products\// } },
            { $regexMatch: { input: { $ifNull: ['$metadata.pathname', ''] }, regex: /\/products\// } },
            { $regexMatch: { input: { $ifNull: ['$metadata.href', ''] }, regex: /\/products\// } },
          ],
        },
      ],
    },
  ],
};

module.exports = {
  extractProductPath,
  inferProductFromUrl,
  isProductPageUrl,
  PRODUCT_VIEW_MATCH_EXPR,
};
