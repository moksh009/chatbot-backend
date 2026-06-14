'use strict';

const express = require('express');
const { protect, verifyClientAccess } = require('../middleware/auth');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { parseDateRange } = require('../utils/commerce/abandonedCartWorkspace');
const { calculateRecoveryMetrics } = require('../services/cartRecoveryMetricsService');

const router = express.Router();

/**
 * GET /api/cart-recovery/metrics
 * Canonical cart recovery metrics (SSOT — cohort abandon-date axis).
 *
 * Query: ?from=ISO&to=ISO&preset=30d&mode=cohort&includeFunnel=true&includeRows=false
 */
router.get('/metrics', protect, verifyClientAccess, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }

    const { from, to, timezone } = parseDateRange(req.query);
    const mode = req.query.mode === 'activity' ? 'activity' : 'cohort';
    const includeFunnel = req.query.includeFunnel !== 'false';
    const includeRows = req.query.includeRows === 'true';
    const reconcileFirst = req.query.reconcileFirst !== 'false';

    const metrics = await calculateRecoveryMetrics(clientId, {
      mode,
      from,
      to,
      timezone,
      includeFunnel,
      includeRows,
      reconcileFirst,
    });

    res.json({ success: true, ...metrics });
  } catch (err) {
    console.error('[CartRecovery] metrics error:', err);
    res.status(500).json({ success: false, message: 'Failed to load cart recovery metrics' });
  }
});

module.exports = router;
