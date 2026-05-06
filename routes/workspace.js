'use strict';

const express = require('express');
const router = express.Router();
const Client = require('../models/Client');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { buildConnectionStatusPayload } = require('../utils/connectionStatus');

/**
 * GET /api/workspace/:clientId/connection-status
 * Never returns 400 for missing integrations — always 200 with booleans.
 */
router.get('/:clientId/connection-status', protect, verifyClientAccess, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId })
      .select({
        shopDomain: 1,
        shopifyAccessToken: 1,
        commerce: 1,
        phoneNumberId: 1,
        wabaId: 1,
        whatsappToken: 1,
        whatsapp: 1,
        instagramAccessToken: 1,
        instagramPageId: 1,
        social: 1,
        metaAdsConnected: 1,
        metaAdsToken: 1,
        metaAdAccountId: 1,
      })
      .lean();

    const flags = buildConnectionStatusPayload(client);
    return res.json({
      success: true,
      clientId,
      ...flags,
    });
  } catch (err) {
    console.warn('[workspace] connection-status:', err.message);
    return res.json({
      success: true,
      clientId: req.params.clientId,
      shopify_connected: false,
      whatsapp_connected: false,
      meta_connected: false,
      instagram_connected: false,
    });
  }
});

module.exports = router;
