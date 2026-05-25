'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const loadClientConfig = require('../middleware/clientConfig');
const { buildMarketingHubHealth } = require('../utils/hub/marketingHubHealth');
const { buildMetaHubHealth } = require('../utils/hub/metaHubHealth');

function assertClientAccess(req, res) {
  const { clientId } = req.params;
  if (req.user?.clientId && req.user.clientId !== clientId && req.user?.role !== 'super-admin') {
    res.status(403).json({ success: false, message: 'Forbidden' });
    return false;
  }
  return true;
}

router.get('/marketing/:clientId/health', protect, async (req, res) => {
  try {
    if (!assertClientAccess(req, res)) return;
    const data = await buildMarketingHubHealth(req.params.clientId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[MarketingHealth]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/meta/:clientId/health', protect, loadClientConfig, async (req, res) => {
  try {
    if (!assertClientAccess(req, res)) return;
    const data = await buildMetaHubHealth(req.params.clientId, req.clientConfig);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[MetaHealth]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
