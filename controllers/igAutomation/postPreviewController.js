const axios = require('axios');
const Client = require('../../models/Client');
const { decrypt } = require('../../utils/encryption');

const previewCache = new Map(); // in-memory cache, keyed by shortcode

async function fetchPostPreview(req, res) {
  try {
    const { url, clientId } = req.body;

    if (!url || !clientId) {
      return res.status(400).json({ error: 'url and clientId are required.' });
    }

    // Extract shortcode from URL server-side — never trust client parsing
    const shortcodeMatch = url.match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
    if (!shortcodeMatch) {
      return res.status(400).json({ error: 'Invalid Instagram URL. Must be a post, reel, or TV URL.' });
    }
    const shortcode = shortcodeMatch[2];

    // Check cache
    if (previewCache.has(shortcode)) {
      console.log('[PostPreview] Cache hit for shortcode:', shortcode);
      return res.json(previewCache.get(shortcode));
    }

    const client = await Client.findOne({ clientId }).select('igUserId igAccessToken igUsername igProfilePicUrl').lean();
    if (!client?.igUserId || !client?.igAccessToken) {
      return res.status(422).json({ error: 'No Instagram account connected for this workspace.' });
    }

    const accessToken = decrypt(client.igAccessToken);

    // Paginate through the account's media to find the shortcode match
    let mediaObject = null;
    let nextUrl = `https://graph.facebook.com/v21.0/${client.igUserId}/media?fields=id,shortcode,caption,media_type,media_url,thumbnail_url,timestamp,permalink,username&limit=50&access_token=${accessToken}`;

    let pageCount = 0;
    const MAX_PAGES = 10; // prevent infinite loop

    while (nextUrl && pageCount < MAX_PAGES) {
      const response = await axios.get(nextUrl, { timeout: 10000 });
      const items = response.data.data || [];

      for (const item of items) {
        if (item.shortcode === shortcode) {
          mediaObject = item;
          break;
        }
      }

      if (mediaObject) break;
      nextUrl = response.data.paging?.next || null;
      pageCount++;
    }

    if (!mediaObject) {
      return res.status(404).json({ error: 'Post not found. Make sure this post belongs to the connected Instagram account.' });
    }

    // For carousel, fetch first child
    let previewImageUrl = mediaObject.media_url;
    if (mediaObject.media_type === 'CAROUSEL_ALBUM') {
      try {
        const childrenRes = await axios.get(
          `https://graph.facebook.com/v21.0/${mediaObject.id}/children?fields=media_url,thumbnail_url,media_type&access_token=${accessToken}`,
          { timeout: 8000 }
        );
        const firstChild = childrenRes.data.data?.[0];
        if (firstChild) {
          previewImageUrl = firstChild.media_url || firstChild.thumbnail_url;
        }
      } catch (childErr) {
        console.warn('[PostPreview] Failed to fetch carousel children, using parent:', childErr.message);
      }
    }

    // For video/reel, use thumbnail_url as the preview image, never stream video
    if (mediaObject.media_type === 'VIDEO') {
      previewImageUrl = mediaObject.thumbnail_url || mediaObject.media_url;
    }

    const result = {
      mediaId: mediaObject.id,
      shortcode: mediaObject.shortcode,
      mediaType: mediaObject.media_type,
      thumbnailUrl: previewImageUrl,
      mediaUrl: mediaObject.media_url,
      caption: mediaObject.caption || '',
      permalink: mediaObject.permalink,
      timestamp: mediaObject.timestamp,
      igUsername: client.igUsername || mediaObject.username,
      profilePicUrl: client.igProfilePicUrl || null
    };

    // Cache for 30 minutes
    previewCache.set(shortcode, result);
    setTimeout(() => previewCache.delete(shortcode), 30 * 60 * 1000);

    console.log('[PostPreview] Fetched media_id:', result.mediaId, 'for shortcode:', shortcode);
    return res.json(result);

  } catch (err) {
    if (err.response) {
      const code = err.response.data?.error?.code;
      const msg = err.response.data?.error?.message || '';
      console.error('[PostPreview] Graph API error:', code, msg);

      if (code === 190) return res.status(401).json({ error: 'Instagram token expired. Please reconnect your account.' });
      if (code === 10) return res.status(403).json({ error: 'Missing Instagram permissions. Please reconnect your account.' });
      if (code === 100) return res.status(404).json({ error: 'Post not found or is from a private account.' });
    }
    if (err.code === 'ECONNABORTED') return res.status(504).json({ error: 'Request timed out. Please try again.' });
    console.error('[PostPreview] Unexpected error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch post preview.' });
  }
}

module.exports = { fetchPostPreview };
