"use strict";

const express = require('express');
const router = express.Router();
const Client = require('../../models/Client');
const { callGraphAPI } = require('../../utils/igGraphApi');
const log = require('../../utils/logger')('IGMedia');

/**
 * GET /api/ig-automation/media
 * Fetch the authenticated user's recent Instagram posts/reels for the Post Grid Picker.
 * Returns thumbnail, caption, type, and permalink for each media item.
 *
 * Query params:
 *  - clientId (required)
 *  - limit: number (default: 20, max: 50)
 *  - after: pagination cursor
 */
router.get('/media', async (req, res) => {
  try {
    const { clientId, limit: rawLimit, after } = req.query;

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    const client = await Client.findOne({ clientId }).lean();
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const accessToken = client.instagramAccessToken || client.social?.instagram?.accessToken;
    if (!accessToken) {
      return res.status(422).json({
        error: 'Instagram is not connected.',
        connected: false
      });
    }

    const igUserId = client.instagramPageId || client.social?.instagram?.pageId;
    if (!igUserId) {
      return res.status(422).json({
        error: 'Instagram Page ID not found. Please reconnect your Instagram account.',
        connected: false
      });
    }

    const limit = Math.min(parseInt(rawLimit) || 20, 50);

    // Build Graph API params
    const fields = 'id,caption,media_type,media_url,thumbnail_url,timestamp,permalink';
    const params = { fields, limit };

    if (after) {
      params.after = after;
    }

    // callGraphAPI signature: (method, endpoint, data, accessToken, opts)
    const data = await callGraphAPI(
      'GET',
      `/${igUserId}/media`,
      params,
      accessToken,
      { clientId }
    );

    const mediaItems = (data.data || []).map(item => ({
      id: item.id,
      caption: (item.caption || '').substring(0, 200),
      mediaType: item.media_type, // IMAGE, VIDEO, CAROUSEL_ALBUM
      mediaUrl: item.media_url || null,
      thumbnailUrl: item.thumbnail_url || item.media_url || null,
      timestamp: item.timestamp,
      permalink: item.permalink
    }));

    // Pagination cursors
    const paging = data.paging || {};

    return res.json({
      success: true,
      connected: true,
      media: mediaItems,
      paging: {
        after: paging.cursors?.after || null,
        hasMore: !!paging.next
      }
    });

  } catch (err) {
    log.error('[Media] Error fetching IG media:', err.message);

    const errCode = err.response?.data?.error?.code;
    if (errCode === 190 || err.message?.includes('token')) {
      return res.status(400).json({
        error: 'Instagram token expired. Please reconnect in Settings.',
        connected: false
      });
    }

    return res.status(500).json({ error: 'Failed to fetch Instagram media' });
  }
});

/**
 * GET /api/ig-automation/connection-status
 * Quick check: is Instagram connected for this clientId?
 */
router.get('/connection-status', async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ connected: false });

    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.json({ connected: false });

    const token = client.instagramAccessToken || client.social?.instagram?.accessToken;
    const userId = client.instagramPageId || client.social?.instagram?.pageId;
    const username = client.instagramUsername || client.social?.instagram?.username;

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
