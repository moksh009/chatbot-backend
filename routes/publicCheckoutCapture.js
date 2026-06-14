'use strict';

const express = require('express');
const Client = require('../models/Client');
const { getPublicApiBase } = require('../utils/commerce/abandonedCartReadiness');

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

function normalizeShop(shopRaw) {
  if (!shopRaw) return '';
  let s = String(shopRaw).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, '').split('/')[0];
  if (!s.includes('.')) s = `${s}.myshopify.com`;
  return s;
}

router.get('/config', publicCors, async (req, res) => {
  try {
    const shop = normalizeShop(req.query.shop || req.query.shopDomain);
    if (!shop) {
      return res.status(400).json({ success: false, message: 'shop query required' });
    }

    const client = await Client.findOne({
      $or: [
        { shopDomain: shop },
        { shopDomain: `https://${shop}` },
        { shopDomain: new RegExp(shop.replace('.myshopify.com', ''), 'i') },
      ],
    })
      .select('clientId shopDomain shopifyConnected storeConnected')
      .lean();

    if (!client?.clientId) {
      return res.json({ success: false, enabled: false, message: 'Store not linked to TopEdge' });
    }

    return res.json({
      success: true,
      enabled: true,
      clientId: client.clientId,
      apiBaseUrl: getPublicApiBase(),
      shop,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
