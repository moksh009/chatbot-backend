"use strict";

const express = require("express");
const axios   = require("axios");
const router  = express.Router();
const Client  = require("../models/Client");

const { protect } = require("../middleware/auth");
const { checkLimit } = require("../utils/planLimits");
const { decrypt } = require("../utils/encryption");
const {
  subscribeFacebookPageToWebhooks,
  subscribeInstagramUserToWebhooks
} = require("../utils/igGraphApi");

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Initiate OAuth Flow
// Called when user clicks "Connect Instagram" button in Settings
// Returns a Meta OAuth URL that the frontend opens in a popup
// ─────────────────────────────────────────────────────────────────────────────
router.get("/instagram/initiate/:clientId", protect, async (req, res) => {
  try {
    const { clientId } = req.params;

    // Validate client exists
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    // Validate Subscription limits
    const limits = await checkLimit(client._id, 'instagram');
    if (!limits.allowed) {
        return res.status(403).json({ error: limits.reason || "Instagram integration is locked on your current plan." });
    }

    // Required Meta permissions for Instagram DM + Meta Ads via unified Facebook Login
    const scope = [
      "pages_messaging",
      "instagram_manage_messages",
      "instagram_manage_comments",
      "pages_show_list",
      "instagram_basic",
      "pages_read_engagement",
      "ads_read",
      "ads_management",
      "business_management",
      "read_insights"
    ].join(",");

    // Encode clientId in state to retrieve after callback
    const state = Buffer.from(JSON.stringify({
      clientId,
      timestamp: Date.now()
    })).toString("base64");

    const authUrl = new URL("https://www.facebook.com/v21.0/dialog/oauth");
    authUrl.searchParams.set("client_id",     process.env.META_APP_ID);
    const base = (process.env.BACKEND_URL || "https://chatbot-backend-lg5y.onrender.com").replace(/\/$/, "");
    authUrl.searchParams.set("redirect_uri",  process.env.META_APP_REDIRECT_URI || `${base}/api/oauth/instagram/callback`);
    authUrl.searchParams.set("scope",         scope);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("state",         state);

    res.json({ authUrl: authUrl.toString() });
  } catch (err) {
    console.error("[Instagram OAuth] Initiate error:", err.message);
    res.status(500).json({ error: "Failed to generate OAuth URL" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: OAuth Callback
// Meta redirects here after user authorizes
// Exchanges code for tokens, finds Instagram account, saves to Client
// ─────────────────────────────────────────────────────────────────────────────
router.get("/instagram/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error) {
    console.error("[Instagram OAuth] Auth denied:", error_description);
    return res.redirect(`${frontendUrl}/settings?tab=channels&instagram_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code || !state) {
    return res.redirect(`${frontendUrl}/settings?tab=channels&instagram_error=missing_params`);
  }

  let clientId;
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64").toString());
    clientId = decoded.clientId;
  } catch (_) {
    return res.redirect(`${frontendUrl}/settings?tab=channels&instagram_error=invalid_state`);
  }

  try {
    const redirectUri = process.env.META_APP_REDIRECT_URI ||
      `${process.env.BACKEND_URL || "https://chatbot-backend-lg5y.onrender.com"}/api/oauth/instagram/callback`;

    // ── Exchange code for short-lived user token ──────────────────────────
    const tokenResp = await axios.get("https://graph.facebook.com/v21.0/oauth/access_token", {
      params: {
        client_id:     process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri:  redirectUri,
        code
      }
    });
    const shortToken = tokenResp.data.access_token;

    // ── Exchange for long-lived token (60 days) ───────────────────────────
    const longTokenResp = await axios.get("https://graph.facebook.com/v21.0/oauth/access_token", {
      params: {
        grant_type:        "fb_exchange_token",
        client_id:         process.env.META_APP_ID,
        client_secret:     process.env.META_APP_SECRET,
        fb_exchange_token: shortToken
      }
    });
    const longToken = longTokenResp.data.access_token;
    const expiresIn = longTokenResp.data.expires_in || (60 * 24 * 60 * 60); // default 60 days
    const tokenExpiry = new Date(Date.now() + (expiresIn * 1000));

    // ── Get Facebook Pages with Instagram Business accounts ───────────────
    const pagesResp = await axios.get("https://graph.facebook.com/v21.0/me/accounts", {
      params: {
        access_token: longToken,
        fields:       "id,name,access_token,instagram_business_account"
      }
    });
    const pages = pagesResp.data.data || [];
    console.log(`[Instagram OAuth] Total FB Pages found: ${pages.length}`);
    
    // Log details of each page to see why IG might be missing
    pages.forEach(p => {
      console.log(` - Page: ${p.name} (${p.id}) | IG Account: ${p.instagram_business_account ? 'FOUND (' + p.instagram_business_account.id + ')' : 'NOT LINKED'}`);
    });

    const igPages = pages.filter(p => p.instagram_business_account?.id);
    console.log(`[Instagram OAuth] Filtered IG-linked Pages: ${igPages.length}`);

    if (igPages.length === 0) {
      console.warn(`[Instagram OAuth] No Instagram Business account found for clientId: ${clientId}`);
      return res.redirect(`${frontendUrl}/settings?tab=channels&instagram_error=no_instagram_account`);
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.redirect(`${frontendUrl}/settings?tab=channels&instagram_error=client_not_found`);
    }

    // ── Single Instagram account: auto-connect ───────────────────────────
    if (igPages.length === 1) {
      const page      = igPages[0];
      const igAccount = page.instagram_business_account;

      // Get Instagram account details
      const igDetails = await getInstagramDetails(igAccount.id, page.access_token);

      await Client.findByIdAndUpdate(client._id, {
        instagramConnected:    true,
        instagramPageId:       igDetails.id,
        igUserId:              igDetails.id,
        instagramUsername:     igDetails.username || "",
        instagramAccessToken:  page.access_token, // Use PAGE token for messaging
        instagramTokenExpiry:  tokenExpiry,
        instagramProfilePic:   igDetails.profile_picture_url || "",
        instagramFollowers:    igDetails.followers_count || 0,
        instagramFbPageId:     page.id,
        instagramPendingPages: null,
        instagramPendingToken: "",
        // Unified login: also save the user-level token for Meta Ads access
        metaAdsToken:          longToken,
        metaAdsConnected:      true,
        // Sync with modular social fields
        'social.instagram.connected': true,
        'social.instagram.pageId':    igDetails.id,
        'social.instagram.accessToken': page.access_token,
        'social.instagram.username':  igDetails.username || "",
        'social.metaAds.connected':   true,
        'social.metaAds.accessToken': longToken,
        'social.metaAds.tokenExpiry': tokenExpiry
      });

      // Register webhook subscription (Facebook Page + Instagram Business Account — different hosts)
      await registerInstagramWebhook(page.id, page.access_token, igDetails.id);

      console.log(`[Instagram OAuth] Connected @${igDetails.username} for client ${clientId}`);
      return res.redirect(`${frontendUrl}/settings?tab=channels&instagram_connected=true`);
    }

    // ── Multiple Instagram accounts: save pending, let user choose ────────
    await Client.findByIdAndUpdate(client._id, {
      instagramPendingPages: igPages.map(p => ({
        pageId:      p.id,
        pageName:    p.name,
        pageToken:   p.access_token,
        igAccountId: p.instagram_business_account.id
      })),
      instagramPendingToken: longToken,
      instagramTokenExpiry:  tokenExpiry
    });

    return res.redirect(`${frontendUrl}/settings?tab=channels&instagram_select_page=true&clientId=${clientId}`);

  } catch (err) {
    console.error("[Instagram OAuth] Callback error:", err.response?.data || err.message);
    return res.redirect(`${frontendUrl}/settings?tab=channels&instagram_error=callback_failed`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Select Page (when multiple Instagram accounts exist)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/instagram/select-page/:clientId", protect, async (req, res) => {
  try {
    const { pageId }  = req.body;
    const { clientId }= req.params;

    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    const page = (client.instagramPendingPages || []).find(p => p.pageId === pageId);
    if (!page) return res.status(400).json({ error: "Page not found in pending list" });

    // Get Instagram account details
    const igDetails = await getInstagramDetails(page.igAccountId, page.pageToken);
    const tokenExpiry = client.instagramTokenExpiry || new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    await Client.findByIdAndUpdate(client._id, {
      instagramConnected:    true,
      instagramPageId:       igDetails.id,
      igUserId:              igDetails.id,
      instagramUsername:     igDetails.username || "",
      instagramAccessToken:  page.pageToken,
      instagramTokenExpiry:  tokenExpiry,
      instagramProfilePic:   igDetails.profile_picture_url || "",
      instagramFollowers:    igDetails.followers_count || 0,
      instagramFbPageId:     page.pageId,
      instagramPendingPages: null,
      instagramPendingToken: "",
      // Sync with modular social fields
      'social.instagram.connected': true,
      'social.instagram.pageId':    igDetails.id,
      'social.instagram.accessToken': page.pageToken,
      'social.instagram.username':  igDetails.username || ""
    });

    await registerInstagramWebhook(page.pageId, page.pageToken, page.igAccountId);

    res.json({
      success:  true,
      username: igDetails.username,
      message:  `Connected @${igDetails.username} successfully!`
    });
  } catch (err) {
    console.error("[Instagram OAuth] Select page error:", err.message);
    res.status(500).json({ error: "Failed to connect selected page" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DISCONNECT Instagram
// ─────────────────────────────────────────────────────────────────────────────
router.post("/instagram/disconnect/:clientId", protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    await Client.findOneAndUpdate({ clientId }, {
      instagramConnected:    false,
      instagramPageId:       "",
      instagramUsername:     "",
      instagramAccessToken:  "",
      instagramAppSecret:    "",
      instagramTokenExpiry:  null,
      instagramProfilePic:   "",
      instagramFollowers:    0,
      instagramFbPageId:     "",
      instagramPendingPages: null,
      instagramPendingToken: "",
      // Sync with modular social fields
      'social.instagram.connected': false,
      'social.instagram.accessToken': "",
      'social.instagram.pageId': ""
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET Instagram Connection Status (for frontend page selector)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/instagram/status/:clientId", protect, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.params.clientId })
      .select("instagramConnected instagramUsername instagramProfilePic instagramFollowers instagramTokenExpiry instagramPendingPages instagramFbPageId");

    if (!client) return res.status(404).json({ error: "Client not found" });

    res.json({
      connected:    client.instagramConnected,
      username:     client.instagramUsername,
      profilePic:   client.instagramProfilePic,
      followers:    client.instagramFollowers,
      tokenExpiry:  client.instagramTokenExpiry,
      hasPending:   !!(client.instagramPendingPages?.length),
      pendingPages: client.instagramPendingPages || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getInstagramDetails(igAccountId, pageToken) {
  try {
    const resp = await axios.get(`https://graph.facebook.com/v21.0/${igAccountId}`, {
      params: {
        fields:       "id,name,username,profile_picture_url,followers_count",
        access_token: pageToken
      }
    });
    return resp.data;
  } catch (err) {
    console.error("[Instagram OAuth] Failed to get IG details:", err.response?.data || err.message);
    return { id: igAccountId };
  }
}

async function registerInstagramWebhook(fbPageId, pageToken, igUserId) {
  try {
    await subscribeFacebookPageToWebhooks(fbPageId, pageToken, {});
    if (igUserId) {
      await subscribeInstagramUserToWebhooks(igUserId, pageToken, {});
    }
    console.log(`[Instagram OAuth] Webhooks registered fbPage=${fbPageId} igUser=${igUserId || "n/a"}`);
  } catch (err) {
    console.error("[Instagram OAuth] Webhook registration failed:", err.response?.data || err.message);
    // Non-fatal — user is still connected, webhook can be re-registered later
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export token refresh function for use in cron job
// ─────────────────────────────────────────────────────────────────────────────
async function refreshExpiringInstagramTokens() {
  const fourteenDaysFromNow = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

  const clients = await Client.find({
    instagramConnected:  true,
    instagramTokenExpiry: { $lt: fourteenDaysFromNow, $exists: true, $ne: null }
  });

  console.log(`[Instagram Cron] Checking ${clients.length} clients for token refresh...`);

  for (const client of clients) {
    try {
      // Facebook Login tokens use fb_exchange_token grant type
      // (ig_refresh_token was for the deprecated Instagram Basic Display API)
      const resp = await axios.get("https://graph.facebook.com/v21.0/oauth/access_token", {
        params: {
          grant_type:        "fb_exchange_token",
          client_id:         process.env.META_APP_ID,
          client_secret:     process.env.META_APP_SECRET,
          fb_exchange_token: decrypt(client.instagramAccessToken)
        }
      });

      const newToken = resp.data.access_token;
      const newExpiry = new Date(Date.now() + (resp.data.expires_in ? resp.data.expires_in * 1000 : 60 * 24 * 60 * 60 * 1000));

      const updateFields = {
        instagramAccessToken: newToken,
        instagramTokenExpiry: newExpiry
      };

      // Also refresh Meta Ads token if connected (same user-level token)
      if (client.metaAdsConnected) {
        updateFields.metaAdsToken = newToken;
        updateFields.metaAdsTokenExpiry = newExpiry;
      }

      await Client.findByIdAndUpdate(client._id, updateFields);
      console.log(`[Instagram Cron] Token refreshed for @${client.instagramUsername} (${client.clientId})`);
    } catch (err) {
      console.error(`[Instagram Cron] Token refresh failed for ${client.clientId}:`, err.response?.data || err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta Ads OAuth Callback
// ─────────────────────────────────────────────────────────────────────────────
router.get("/meta-ads/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error) {
    console.error("[MetaAds OAuth] Auth denied:", error_description);
    return res.redirect(`${frontendUrl}/meta-manager?tab=ads&meta_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code || !state) {
    return res.redirect(`${frontendUrl}/meta-manager?tab=ads&meta_error=missing_params`);
  }

  let clientId;
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64").toString());
    clientId = decoded.clientId;
  } catch (_) {
    return res.redirect(`${frontendUrl}/meta-manager?tab=ads&meta_error=invalid_state`);
  }

  try {
    const base = (process.env.BACKEND_URL || process.env.API_BASE || "https://chatbot-backend-lg5y.onrender.com").replace(/\/$/, "");
    const redirectUri = `${base}/api/oauth/meta-ads/callback`;

    // 1. Exchange code for user access token
    const tokenResp = await axios.get("https://graph.facebook.com/v21.0/oauth/access_token", {
      params: {
        client_id:     process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri:  redirectUri,
        code
      }
    });

    const shortToken = tokenResp.data.access_token;

    // 2. Exchange for long-lived token (60 days instead of ~1 hour)
    let accessToken = shortToken;
    try {
      const longTokenResp = await axios.get("https://graph.facebook.com/v21.0/oauth/access_token", {
        params: {
          grant_type:    "fb_exchange_token",
          client_id:     process.env.META_APP_ID,
          client_secret: process.env.META_APP_SECRET,
          fb_exchange_token: shortToken
        }
      });
      accessToken = longTokenResp.data.access_token;
      console.log("[MetaAds] Long-lived token obtained successfully");
    } catch (llErr) {
      console.warn("[MetaAds] Long-lived token exchange failed, using short-lived:", llErr.response?.data?.error?.message || llErr.message);
    }

    // 3. Save token to client
    const client = await Client.findOne({ clientId });
    if (!client) return res.redirect(`${frontendUrl}/meta-manager?tab=ads&meta_error=client_not_found`);

    const tokenExpiry = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days
    await Client.findByIdAndUpdate(client._id, {
      metaAdsToken: accessToken,
      metaAdsConnected: true,
      metaAdsTokenExpiry: tokenExpiry
    });

    // 3. Fetch available ad accounts to see if we should auto-pick or show selector
    const { getAdAccounts } = require("../utils/metaAdsAPI");
    const accounts = await getAdAccounts(accessToken);

    if (accounts.length === 1) {
      // Auto-select the only account
      await Client.findByIdAndUpdate(client._id, {
        metaAdAccountId: accounts[0].id,
        metaAdsAccountName: accounts[0].name
      });
      
      const { syncMetaAds } = require("../utils/metaAdsAPI");
      setImmediate(() => syncMetaAds(clientId).catch(console.error));
      
      return res.redirect(`${frontendUrl}/meta-manager?tab=ads&meta_ads_connected=true`);
    }

    // Redirect to selector
    return res.redirect(`${frontendUrl}/meta-manager?tab=ads&meta_ads_select_account=true&clientId=${clientId}`);

  } catch (err) {
    console.error("[MetaAds OAuth] Callback error:", err.response?.data || err.message);
    return res.redirect(`${frontendUrl}/meta-manager?tab=ads&meta_error=callback_failed`);
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// Google / Gmail OAuth Flow — Used for direct Gmail email sending
// Uses GCAL_CLIENT_ID / GCAL_CLIENT_SECRET env vars (shared Google Cloud project)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/google/start/:clientId", protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    const state = Buffer.from(JSON.stringify({ clientId, timestamp: Date.now() })).toString("base64");
    const base = (process.env.BACKEND_URL || "https://chatbot-backend-lg5y.onrender.com").replace(/\/$/, "");
    const redirectUri = `${base}/api/oauth/google/callback`;

    if (!process.env.GCAL_CLIENT_ID) {
      return res.status(500).json({ error: "GCAL_CLIENT_ID is not configured" });
    }

    // Gmail send scope + profile to get email address
    const scopes = [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile"
    ].join(" ");

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", process.env.GCAL_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", scopes);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");

    res.json({ authUrl: authUrl.toString() });
  } catch (err) {
    console.error("[Google OAuth] Start error:", err.message);
    res.status(500).json({ error: "Failed to generate Google OAuth URL" });
  }
});

router.get("/google/callback", async (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error) {
    console.error("[Google OAuth] Auth denied:", error);
    return res.redirect(`${frontendUrl}/settings?tab=integrations&google_error=${encodeURIComponent(error)}`);
  }

  if (!code || !state) {
    return res.redirect(`${frontendUrl}/settings?tab=integrations&google_error=missing_params`);
  }

  let clientId;
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64").toString());
    clientId = decoded.clientId;
  } catch (_) {
    return res.redirect(`${frontendUrl}/settings?tab=integrations&google_error=invalid_state`);
  }

  try {
    if (!process.env.GCAL_CLIENT_ID || !process.env.GCAL_CLIENT_SECRET) {
      return res.redirect(`${frontendUrl}/settings?tab=integrations&google_error=config_error`);
    }

    const base = (process.env.BACKEND_URL || "https://chatbot-backend-lg5y.onrender.com").replace(/\/$/, "");
    const redirectUri = `${base}/api/oauth/google/callback`;

    // Exchange code for tokens
    const tokenResp = await axios.post("https://oauth2.googleapis.com/token", null, {
      params: {
        code,
        client_id:     process.env.GCAL_CLIENT_ID,
        client_secret: process.env.GCAL_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    "authorization_code"
      }
    });

    const { access_token, refresh_token } = tokenResp.data;

    // Fetch user email
    const profileResp = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const gmailAddress = profileResp.data.email;

    // Save to client
    await Client.findOneAndUpdate(
      { clientId },
      {
        googleConnected: true,
        gmailAddress,
        gmailAccessToken: access_token,
        gmailRefreshToken: refresh_token || "",
        emailUser: gmailAddress, // Also set the legacy emailUser field
        emailMethod: "gmail_oauth" // Mark that we're using OAuth, not SMTP
      }
    );

    console.log(`[Google OAuth] Gmail connected for ${clientId}: ${gmailAddress}`);
    return res.redirect(`${frontendUrl}/settings?tab=integrations&google_connected=true`);
  } catch (err) {
    console.error("[Google OAuth] Callback error:", err.response?.data || err.message);
    return res.redirect(`${frontendUrl}/settings?tab=integrations&google_error=callback_failed`);
  }
});

router.post("/google/disconnect/:clientId", protect, async (req, res) => {
  try {
    const { clientId } = req.params;

    await Client.findOneAndUpdate(
      { clientId },
      {
        googleConnected: false,
        gmailAddress: "",
        gmailAccessToken: "",
        gmailRefreshToken: "",
        emailUser: "",
        emailMethod: ""
      }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[Google OAuth] Disconnect error:", err.message);
    return res.status(500).json({ error: "Failed to disconnect Google account" });
  }
});
module.exports = router;
module.exports.refreshExpiringInstagramTokens = refreshExpiringInstagramTokens;
