'use strict';

const express = require('express');
const {
  getPublicCheckoutConsentConfig,
} = require('../utils/shopify/checkoutConsentExtension');

const router = express.Router();

function publicCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function resolveApiBaseUrl(req) {
  return (
    process.env.BACKEND_URL ||
    process.env.SERVER_URL ||
    `${req.protocol}://${req.get('host')}`
  ).replace(/\/+$/, '');
}

/**
 * GET /api/public/checkout-consent/config?shop=store.myshopify.com
 * Used by the Shopify Checkout UI extension at runtime.
 */
router.get('/config', publicCors, async (req, res) => {
  try {
    const shop = req.query.shop || req.query.shopDomain || '';
    const apiBaseUrl = resolveApiBaseUrl(req);
    const config = await getPublicCheckoutConsentConfig(shop, apiBaseUrl);
    if (!config) {
      return res.status(404).json({
        success: false,
        message: 'Store not linked to TopEdge or Shopify not connected',
      });
    }
    return res.json({ success: true, ...config });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
