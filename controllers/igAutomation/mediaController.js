"use strict";

// IG Automation — Connection-Status Controller
// =============================================
// The previous post-grid fetch endpoint (/api/ig-automation/media) lived here.
// It has been removed: the wizard now pastes a URL and the server resolves it
// via /api/ig-automation/fetch-post-preview. See postPreviewController.
//
// This file now only owns the lightweight connection-status pulse that the
// IGAutomationPage header chip uses.

const express = require('express');
const router = express.Router();
const Client = require('../../models/Client');
const log = require('../../utils/logger')('IGMedia');

/**
 * GET /api/ig-automation/connection-status?clientId=X
 * Quick check: is Instagram connected for this clientId?
 */
router.get('/connection-status', async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ connected: false });

    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.json({ connected: false });

    const token =
      client.igAccessToken ||
      client.instagramAccessToken ||
      client.social?.instagram?.accessToken;
    const userId =
      client.igUserId ||
      client.igPageId ||
      client.instagramPageId ||
      client.social?.instagram?.pageId;
    const username =
      client.igUsername ||
      client.instagramUsername ||
      client.social?.instagram?.username;

    return res.json({
      connected: !!(token && userId),
      username: username || null
    });
  } catch (err) {
    log.error('[Connection] Error checking IG status:', err.message);
    return res.json({ connected: false });
  }
});

module.exports = router;
