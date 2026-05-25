'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const Client = require('../models/Client');
const { recordCheckoutMarketingOptIn } = require('../utils/commerce/checkoutMarketingConsent');

const router = express.Router();

const consentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests.' },
});

/**
 * POST /api/public/checkout-consent
 * Body: { embedKey | clientId, phone?, email?, marketingOptIn, checkoutToken?, shopifyClientId?, visitorId? }
 */
router.post('/', consentLimiter, async (req, res) => {
  try {
    const embedKey = String(req.body.embedKey || req.body.key || '').trim();
    let clientId = String(req.body.clientId || '').trim();

    if (embedKey && !clientId) {
      const client = await Client.findOne({
        growthEmbedPublicKey: embedKey,
        growthEmbedEnabled: { $ne: false },
      })
        .select('clientId')
        .lean();
      if (!client) return res.status(404).json({ success: false, message: 'Unknown embed key' });
      clientId = client.clientId;
    }

    if (!clientId) {
      return res.status(400).json({ success: false, message: 'clientId or embedKey required' });
    }

    const marketingOptIn =
      req.body.marketingOptIn === true ||
      req.body.whatsappMarketing === true ||
      req.body.acceptsMarketing === true;

    const result = await recordCheckoutMarketingOptIn({
      clientId,
      phone: req.body.phone || req.body.phoneNumber,
      email: req.body.email,
      checkoutToken: req.body.checkoutToken,
      shopifyClientId: req.body.shopifyClientId,
      visitorId: req.body.visitorId,
      marketingOptIn,
      source: req.body.source || 'checkout_extension',
    });

    if (!result.success) {
      return res.status(400).json({ success: false, ...result });
    }
    return res.json({ success: true, ...result });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
