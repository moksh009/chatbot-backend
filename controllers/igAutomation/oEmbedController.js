"use strict";

const express = require('express');
const router = express.Router();
const axios = require('axios');
const log = require('../../utils/logger')('IGOEmbed');

// In-memory cache with manual TTL — upgrade to Redis if needed in production
const oEmbedCache = new Map();

// URL validation pattern for Instagram posts/reels/tv
const INSTAGRAM_URL_PATTERN = /^https:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?/;

/**
 * POST /api/ig-automation/oembed
 * Resolves an Instagram post URL into structured media metadata using Facebook's oEmbed API.
 * 
 * Root causes fixed:
 *  1. Token construction: uses FACEBOOK_APP_ID|FACEBOOK_APP_SECRET (not META_APP_ID or FACEBOOK_APP_TOKEN)
 *  2. API version pinned to v19.0
 *  3. URL properly encoded with encodeURIComponent()
 *  4. Explicit fields parameter requested
 *  5. Categorized error handling (400/401/403/429/504)
 */
router.post('/oembed', async (req, res) => {
  try {
    const { url, clientId } = req.body;

    if (!url || !clientId) {
      return res.status(400).json({ error: 'url and clientId are required.' });
    }

    // Strict URL validation — only accept known Instagram post/reel/tv paths
    if (!INSTAGRAM_URL_PATTERN.test(url)) {
      return res.status(400).json({ error: 'Invalid Instagram URL. Must be a post, reel, or TV URL.' });
    }

    // Check in-memory cache first
    if (oEmbedCache.has(url)) {
      log.info('[oEmbed] Cache hit for URL:', url);
      return res.json(oEmbedCache.get(url));
    }

    // Build the App Access Token — this is NOT a user or page token
    if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
      log.error('[oEmbed] Missing FACEBOOK_APP_ID or FACEBOOK_APP_SECRET environment variables.');
      return res.status(500).json({ error: 'Server configuration error. Contact support.' });
    }

    const appToken = `${process.env.FACEBOOK_APP_ID}|${process.env.FACEBOOK_APP_SECRET}`;

    const endpoint = `https://graph.facebook.com/v19.0/instagram_oembed?url=${encodeURIComponent(url)}&access_token=${appToken}&fields=author_name,author_url,thumbnail_url,title,html,provider_name`;

    log.info('[oEmbed] Fetching from Meta for URL:', url);

    const response = await axios.get(endpoint, { timeout: 10000 });
    const data = response.data;

    // Extract the shortcode from the URL for reference (oEmbed does not return mediaId)
    const shortcodeMatch = url.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
    const shortcode = shortcodeMatch ? shortcodeMatch[2] : null;

    const result = {
      authorName: data.author_name || 'Unknown',
      authorUrl: data.author_url || null,
      thumbnailUrl: data.thumbnail_url || null,
      caption: data.title || '',
      shortcode,
      providerName: data.provider_name || 'Instagram'
    };

    // Cache the result for 1 hour
    oEmbedCache.set(url, result);
    setTimeout(() => oEmbedCache.delete(url), 60 * 60 * 1000);

    log.info('[oEmbed] Success for URL:', url, '| Author:', result.authorName);
    return res.json(result);

  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      const errorData = err.response.data?.error;
      log.error('[oEmbed] Meta API error:', status, JSON.stringify(errorData));

      if (status === 400) {
        const message = errorData?.message || '';
        if (message.includes('private')) {
          return res.status(422).json({ error: 'This post is from a private account and cannot be fetched.' });
        }
        return res.status(400).json({ error: 'Invalid Instagram URL or the post no longer exists.' });
      }

      if (status === 401 || status === 403) {
        return res.status(500).json({ error: 'Instagram API authentication failed. Contact support.' });
      }

      if (status === 429) {
        return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
      }
    }

    if (err.code === 'ECONNABORTED') {
      log.error('[oEmbed] Timeout fetching URL:', err.config?.url);
      return res.status(504).json({ error: 'Request timed out. Please try again.' });
    }

    log.error('[oEmbed] Unexpected error:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred while fetching the post.' });
  }
});

module.exports = router;
