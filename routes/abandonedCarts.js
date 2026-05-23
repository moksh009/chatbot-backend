'use strict';

const express = require('express');
const { protect } = require('../middleware/auth');
const { tenantClientId } = require('../utils/queryHelpers');
const { buildAbandonedCartWorkspace } = require('../utils/abandonedCartWorkspace');
const { logAction } = require('../middleware/audit');
const logPersonalDataAccess = logAction('PERSONAL_DATA_ACCESS');

const router = express.Router();

/**
 * GET /api/abandoned-carts/workspace
 * Metrics + table rows for Audience → Abandoned carts (date range / preset).
 */
router.get('/workspace', protect, logPersonalDataAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    const data = await buildAbandonedCartWorkspace(clientId, req.query);
    res.json(data);
  } catch (err) {
    console.error('[AbandonedCarts] workspace error:', err);
    res.status(500).json({ success: false, message: 'Failed to load abandoned cart workspace' });
  }
});

module.exports = router;
