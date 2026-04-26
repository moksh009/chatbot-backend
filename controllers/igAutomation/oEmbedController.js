"use strict";

const express = require('express');
const router = express.Router();
const axios = require('axios');
const NodeCache = require('node-cache');
const log = require('../../utils/logger')('IGOEmbed');

// In-memory cache with 1-hour TTL for oEmbed results
const oEmbedCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// URL validation pattern for Instagram posts/reels/tv
const INSTAGRAM_URL_PATTERN = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+\/?/i;

/**
 * POST /api/ig-automation/oembed
 * Resolves an Instagram post URL into structured media metadata using Facebook's oEmbed API.
 */
router.post('/oembed', async (req, res) => {
  try {
    const { url, clientId } = req.body;

    if (!url || !clientId) {
      return res.status(400).json({ success: false, error: 'url and clientId are required' });
    }

    // Validate URL format
    if (!INSTAGRAM_URL_PATTERN.test(url)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL format. Must be an Instagram post, reel, or IGTV URL (https://www.instagram.com/p/... or /reel/... or /tv/...)'
      });
    }

    // Check cache first
    const cached = oEmbedCache.get(url);
    if (cached) {
      log.info(`[oEmbed] Cache hit for ${url}`);
      return res.status(200).json({ success: true, ...cached });
    }

    // Build the Facebook oEmbed API URL
    // Meta allows using 'app_id|app_secret' as a valid App Access Token
    const fallbackToken = (process.env.META_APP_ID && process.env.META_APP_SECRET) 
      ? `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}` 
      : null;
    const appToken = process.env.FACEBOOK_APP_TOKEN || fallbackToken;
    
    if (!appToken) {
      return res.status(500).json({
        success: false,
        error: 'Facebook App Token not configured. Contact your administrator.'
      });
    }

    const encodedUrl = encodeURIComponent(url);
    const oEmbedUrl = `https://graph.facebook.com/v19.0/instagram_oembed?url=${encodedUrl}&access_token=${appToken}&fields=author_name,thumbnail_url,title,html`;

    const response = await axios.get(oEmbedUrl, { timeout: 10000 });
    const data = response.data;

    if (!data) {
      return res.status(422).json({
        success: false,
        error: 'Could not retrieve post data. The post may be from a private account.'
      });
    }

    // Extract shortcode from URL path
    const urlPath = new URL(url).pathname;
    const shortcodeMatch = urlPath.match(/\/(p|reel|tv)\/([\w-]+)/);
    const shortcode = shortcodeMatch ? shortcodeMatch[2] : null;

    const result = {
      authorName: data.author_name || '',
      thumbnailUrl: data.thumbnail_url || '',
      caption: (data.title || '').substring(0, 120),
      shortcode,
      providerName: 'Instagram'
    };

    // Cache the result
    oEmbedCache.set(url, result);

    log.info(`[oEmbed] Fetched successfully for ${url} (author: ${result.authorName})`);
    res.status(200).json({ success: true, ...result });

  } catch (error) {
    const status = error.response?.status;
    const errorData = error.response?.data;

    if (status === 404) {
      return res.status(404).json({
        success: false,
        error: 'Post not found. Please check the URL and try again.'
      });
    }

    if (status === 400 && errorData?.error?.code === 100) {
      return res.status(422).json({
        success: false,
        error: 'This post is from a private account and cannot be accessed.'
      });
    }

    log.error('[oEmbed] Fetch error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch post preview. Please try again.'
    });
  }
});

module.exports = router;
