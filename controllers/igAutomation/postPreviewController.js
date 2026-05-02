"use strict";

// IG Automation — Post Preview Controller
// =========================================
// Resolves an Instagram post URL pasted by the operator into the structured
// metadata the wizard needs to wire up a Comment-to-DM automation:
//   { mediaId, shortcode, mediaType, thumbnailUrl, caption, permalink, authorUsername, verified }
//
// Two-stage flow (the previous 400-bug came from mixing token types here):
//   1. instagram_oembed   — uses the APP ACCESS TOKEN (`{APP_ID}|{APP_SECRET}`).
//                           Returns thumbnail + author_name without requiring
//                           the user to own the post.
//   2. /{ig-user-id}/media — uses the PAGE ACCESS TOKEN. Walks the connected
//                           account's media to find the matching shortcode and
//                           recover the numeric mediaId required for webhook
//                           matching at runtime.
// Anything other than this token split returns 400 from Meta.

const axios = require('axios');
const Client = require('../../models/Client');
const { decrypt } = require('../../utils/encryption');
const { GRAPH_BASE_URL } = require('../../utils/igGraphApi');

const INSTAGRAM_URL_REGEX = /instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/;
const PREVIEW_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MEDIA_PAGES = 15;            // covers ~750 most recent posts at limit=50

// Per-shortcode in-memory cache. Upgrade to Redis if we ever need cross-instance
// dedup, but for a single Render dyno this is plenty.
const previewCache = new Map();

function setCached(shortcode, value) {
  previewCache.set(shortcode, value);
  setTimeout(() => previewCache.delete(shortcode), PREVIEW_TTL_MS).unref?.();
}

function normalizeUsername(input) {
  return (input || '').replace(/^@/, '').toLowerCase().trim();
}

async function fetchPostPreview(req, res) {
  try {
    const { url, clientId } = req.body || {};

    if (!url || !clientId) {
      return res.status(400).json({ error: 'url and clientId are required.' });
    }

    const match = url.match(INSTAGRAM_URL_REGEX);
    if (!match) {
      return res.status(400).json({
        error: 'Invalid Instagram URL. Paste a post, reel, or TV link from instagram.com.'
      });
    }
    const shortcode = match[2];

    if (previewCache.has(shortcode)) {
      return res.json(previewCache.get(shortcode));
    }

    // ── Resolve the connected account ────────────────────────────────
    const client = await Client.findOne({ clientId })
      .select([
        'igUserId', 'igPageId', 'igUsername', 'igAccessToken',
        'instagramPageId', 'instagramAccessToken', 'instagramUsername',
        'social.instagram.pageId', 'social.instagram.accessToken', 'social.instagram.username'
      ].join(' '))
      .lean();

    if (!client) {
      return res.status(404).json({ error: 'Workspace not found.' });
    }

    const igUserId =
      client.igUserId ||
      client.instagramPageId ||
      client.social?.instagram?.pageId;

    const rawToken =
      client.igAccessToken ||
      client.instagramAccessToken ||
      client.social?.instagram?.accessToken;

    const connectedUsername = normalizeUsername(
      client.igUsername || client.instagramUsername || client.social?.instagram?.username
    );

    if (!igUserId || !rawToken) {
      return res.status(422).json({
        error: 'Instagram is not connected. Go to Settings → Integrations → Instagram to connect.'
      });
    }

    let pageToken;
    try {
      pageToken = decrypt(rawToken);
    } catch (decErr) {
      console.error('[PostPreview] Token decrypt failed:', decErr.message);
      return res.status(500).json({ error: 'Stored Instagram token is unreadable. Please reconnect.' });
    }
    if (!pageToken) {
      return res.status(422).json({ error: 'Instagram token missing. Please reconnect.' });
    }

    // ── STEP 1: oEmbed (App Access Token) ────────────────────────────
    // This is the bug fix for the 400. oEmbed REQUIRES the app token
    // `{FACEBOOK_APP_ID}|{FACEBOOK_APP_SECRET}`. Anything else — page
    // token, user token, system user token — gets rejected with code 100.
    const appId = process.env.FACEBOOK_APP_ID || process.env.META_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      console.error('[PostPreview] FACEBOOK_APP_ID / FACEBOOK_APP_SECRET not configured');
      return res.status(500).json({
        error: 'Server is missing Instagram app credentials. Contact support.'
      });
    }
    const appToken = `${appId}|${appSecret}`;

    let oEmbedData = null;
    try {
      const oEmbedRes = await axios.get(`${GRAPH_BASE_URL}/instagram_oembed`, {
        params: {
          url,
          access_token: appToken,
          fields: 'author_name,thumbnail_url,title,html,provider_name'
        },
        timeout: 10000
      });
      oEmbedData = oEmbedRes.data || {};
    } catch (oErr) {
      const status = oErr.response?.status;
      const errCode = oErr.response?.data?.error?.code;
      const errMsg = oErr.response?.data?.error?.message || '';
      console.error('[PostPreview] oEmbed failed', { status, errCode, errMsg });

      if (status === 404 || errCode === 100) {
        return res.status(404).json({
          error: 'Post not found. It may be from a private account or has been deleted.'
        });
      }
      if (status === 429) {
        return res.status(429).json({ error: 'Rate limited by Instagram. Please wait a minute and try again.' });
      }
      return res.status(400).json({
        error: 'Could not fetch post preview from Instagram. Check the URL and try again.'
      });
    }

    // ── STEP 2: Verify the post belongs to the connected account ─────
    const oEmbedAuthor = normalizeUsername(oEmbedData.author_name);
    if (oEmbedAuthor && connectedUsername && oEmbedAuthor !== connectedUsername) {
      return res.status(422).json({
        error: `This post belongs to @${oEmbedAuthor}, not your connected account @${connectedUsername}. Paste a URL from your own Instagram account.`
      });
    }

    // ── STEP 3: Resolve numeric mediaId via /{ig-user-id}/media ──────
    // Webhook payloads identify the post by mediaId, not shortcode. We
    // must walk the account's media list once at setup time and persist
    // the mediaId in automation.post.mediaId so the webhook processor
    // can match incoming comments cheaply.
    let mediaId = null;
    let mediaType = null;
    let apiThumbnail = null;

    try {
      const initialUrl =
        `${GRAPH_BASE_URL}/${igUserId}/media` +
        `?fields=id,shortcode,media_type,thumbnail_url,media_url,timestamp` +
        `&limit=50&access_token=${pageToken}`;

      let nextUrl = initialUrl;
      let pageCount = 0;
      let found = false;

      while (nextUrl && pageCount < MAX_MEDIA_PAGES && !found) {
        const mediaRes = await axios.get(nextUrl, { timeout: 12000 });
        const items = mediaRes.data?.data || [];
        for (const item of items) {
          if (item.shortcode === shortcode) {
            mediaId = item.id;
            mediaType = item.media_type || null;
            apiThumbnail = item.thumbnail_url || item.media_url || null;
            found = true;
            break;
          }
        }
        nextUrl = found ? null : (mediaRes.data?.paging?.next || null);
        pageCount += 1;
      }

      if (!found) {
        console.warn('[PostPreview] Shortcode not found in /media', { shortcode, igUserId });
        return res.status(404).json({
          error: 'Post not found on your connected account. Make sure the URL is from your own Instagram account.'
        });
      }
    } catch (mErr) {
      const status = mErr.response?.status;
      const errCode = mErr.response?.data?.error?.code;
      const errMsg = mErr.response?.data?.error?.message || mErr.message;
      console.error('[PostPreview] Media lookup failed', { status, errCode, errMsg });

      if (errCode === 190) {
        return res.status(401).json({ error: 'Instagram token expired. Please reconnect your account.' });
      }
      if (errCode === 10 || status === 403) {
        return res.status(403).json({ error: 'Missing Instagram permissions. Please reconnect your account.' });
      }
      return res.status(500).json({
        error: 'Could not verify the post on your account. Please try again.'
      });
    }

    const result = {
      mediaId,
      shortcode,
      mediaType: mediaType || 'IMAGE',
      thumbnailUrl: apiThumbnail || oEmbedData.thumbnail_url || null,
      caption: oEmbedData.title || '',
      permalink: url,
      authorUsername: oEmbedAuthor || connectedUsername || null,
      verified: true
    };

    setCached(shortcode, result);
    console.log('[PostPreview] Resolved', { shortcode, mediaId, mediaType: result.mediaType });
    return res.json(result);

  } catch (err) {
    console.error('[PostPreview] Unexpected error:', err.stack || err.message);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

module.exports = { fetchPostPreview };
