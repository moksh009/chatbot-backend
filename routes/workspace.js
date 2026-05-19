'use strict';

const express = require('express');
const router = express.Router();
const { protect, verifyClientAccess } = require('../middleware/auth');
const { buildConnectionStatusPayload } = require('../utils/connectionStatus');
const { apiCache } = require('../middleware/apiCache');
const { getCachedClient, CONNECTION_STATUS_SELECT } = require('../utils/clientCache');

/**
 * GET /api/workspace/:clientId/connection-status
 * Never returns 400 for missing integrations — always 200 with booleans.
 */
router.get('/:clientId/connection-status', protect, verifyClientAccess, apiCache(90), async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await getCachedClient(clientId, CONNECTION_STATUS_SELECT);

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
