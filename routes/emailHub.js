'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { verifyTenantScope } = require('../middleware/verifyTenantScope');
const {
  getEmailHubSummary,
  getEmailHubLogs,
  getEmailHubSequenceMails,
} = require('../services/emailHubService');

router.get('/:clientId/summary', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await getEmailHubSummary(req.params.clientId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load email summary' });
  }
});

router.get('/:clientId/logs', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await getEmailHubLogs(req.params.clientId, {
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
      source: req.query.source,
      days: req.query.days,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load email logs' });
  }
});

router.get('/:clientId/sequence-mails', protect, verifyTenantScope(), async (req, res) => {
  try {
    const data = await getEmailHubSequenceMails(req.params.clientId, {
      limit: req.query.limit,
      status: req.query.status,
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Failed to load sequence emails' });
  }
});

module.exports = router;
