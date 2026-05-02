"use strict";

const axios = require('axios');
const log = require('./logger')('IGGraphAPI');

// Instagram Graph API version. Pinned to v19.0 — confirmed working as of 2025
// for IG Messaging, instagram_oembed, and Page-token Comment APIs. Do not change
// without re-validating every IG endpoint manually against the Meta changelog.
const GRAPH_API_VERSION = process.env.IG_GRAPH_API_VERSION || 'v19.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
/** Instagram Graph host — REQUIRED for `comments` / `mentions` webhook subscription */
const INSTAGRAM_GRAPH_BASE_URL = `https://graph.instagram.com/${GRAPH_API_VERSION}`;

/**
 * Hardened Graph API wrapper with retry logic, rate limit handling, and token expiry detection.
 * 
 * Retry strategy:
 * - HTTP 429 (rate limit): wait for Retry-After header value (or 60s default) then retry once
 * - HTTP 500/503 (Meta server error): exponential backoff: 2s → 8s → fail permanently
 * - HTTP 400 (bad request): no retry — log full payload and response
 * - HTTP 190 (token expired): mark client IG disconnected + emit Socket.io event
 */
async function callGraphAPI(method, endpoint, data, accessToken, opts = {}) {
  const baseUrl = opts.baseUrl || GRAPH_BASE_URL;
  const url = endpoint.startsWith('http') ? endpoint : `${baseUrl}${endpoint}`;
  const maxRetries = opts.maxRetries || 2;
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      const config = {
        method,
        url,
        timeout: opts.timeout || 15000,
        headers: { 'Content-Type': 'application/json' }
      };

      // Add access token — either as query param (GET) or in body/params
      if (method.toLowerCase() === 'get') {
        config.params = { ...data, access_token: accessToken };
      } else if (endpoint.includes('/subscribed_apps')) {
        // Meta expects subscribed_fields on the query string for POST, not JSON body
        // (same behavior as the curl examples in the Platform docs).
        config.params = { access_token: accessToken, ...(data || {}) };
      } else {
        config.data = data;
        config.params = { access_token: accessToken };
      }

      const response = await axios(config);
      return response.data;

    } catch (error) {
      const status = error.response?.status;
      const errorData = error.response?.data;
      const errorCode = errorData?.error?.code;

      // Token expired or invalid (OAuthException code 190)
      if (errorCode === 190 || (status === 400 && errorData?.error?.type === 'OAuthException')) {
        log.error(`[Token Expired] Code 190 for endpoint ${endpoint}`, errorData?.error?.message);
        // Mark client disconnected, emit socket event, and send email
        if (opts.clientId) {
          try {
            const Client = require('../models/Client');
            const clientDoc = await Client.findOneAndUpdate(
              { clientId: opts.clientId },
              { $set: { instagramConnected: false, 'social.instagram.connected': false } }
            );
            
            if (global.io) {
              global.io.to(`client_${opts.clientId}`).emit('ig_token_expired', {
                message: 'Your Instagram access token has expired. Please reconnect in Settings → Integrations.'
              });
            }

            // Send proactive email to admin
            if (clientDoc && clientDoc.email) {
              const { sendEmail } = require('./emailService');
              await sendEmail(clientDoc, {
                to: clientDoc.email,
                subject: 'Action Required: Your Instagram Connection Expired',
                html: `
                  <p>Hi there,</p>
                  <p>Meta has revoked your Instagram Page Access Token (this usually happens if you change your password or Meta detects a security event).</p>
                  <p><strong>Your Instagram automations are currently paused.</strong></p>
                  <p>Please log in to your TopEdge AI dashboard and go to Settings → Integrations to reconnect your Instagram account immediately.</p>
                  <p>Best regards,<br/>The TopEdge AI Team</p>
                `
              });
              log.info(`[Token Expired] Sent proactive email to ${clientDoc.email}`);
            }
          } catch (dbErr) {
            log.error('[Token Expired] Failed to handle client disconnection:', dbErr.message);
          }
        }
        
        throw new Error(`Instagram token expired: ${errorData?.error?.message || 'OAuthException'}`);
      }

      // Rate limited (429)
      if (status === 429) {
        const retryAfter = parseInt(error.response.headers['retry-after'] || '60', 10);
        log.warn(`[Rate Limited] Waiting ${retryAfter}s before retry. Endpoint: ${endpoint}`);
        
        if (attempt < 1) {
          await sleep(retryAfter * 1000);
          attempt++;
          continue;
        }
        throw new Error(`Rate limited on ${endpoint} after retry`);
      }

      // Server error (500/503) — exponential backoff
      if (status === 500 || status === 503) {
        const delay = Math.pow(4, attempt) * 500; // 500ms → 2000ms → 8000ms
        log.warn(`[Server Error ${status}] Retry ${attempt + 1}/${maxRetries + 1} in ${delay}ms. Endpoint: ${endpoint}`);
        
        if (attempt < maxRetries) {
          await sleep(delay);
          attempt++;
          continue;
        }
        log.error(`[Server Error ${status}] Permanently failed after ${maxRetries + 1} attempts. Endpoint: ${endpoint}`);
        throw new Error(`Meta API server error ${status} on ${endpoint}`);
      }

      // Bad request (400) — no retry, log fully
      if (status === 400) {
        log.error(`[Bad Request 400] Endpoint: ${endpoint}`, {
          requestData: JSON.stringify(data).substring(0, 500),
          responseError: JSON.stringify(errorData).substring(0, 500)
        });
        throw new Error(`Bad request on ${endpoint}: ${errorData?.error?.message || 'Unknown'}`);
      }

      // Any other error — no retry
      log.error(`[Graph API Error] Status: ${status || 'Network'} Endpoint: ${endpoint}`, error.message);
      throw error;
    }
  }
}

/**
 * Send a DM via Instagram Messaging API
 */
async function sendInstagramDMv2(recipientId, message, accessToken, opts = {}) {
  const payload = {
    recipient: opts.commentId 
      ? { comment_id: opts.commentId } 
      : { id: recipientId },
    message
  };

  return callGraphAPI('post', '/me/messages', payload, accessToken, opts);
}

/**
 * Reply publicly to an Instagram comment
 */
async function replyToCommentv2(commentId, replyText, accessToken, opts = {}) {
  return callGraphAPI('post', `/${commentId}/replies`, { message: replyText }, accessToken, opts);
}

/**
 * Check if a user follows the business Instagram account
 */
async function checkFollowStatusv2(igsid, accessToken, opts = {}) {
  return callGraphAPI('get', `/${igsid}`, { fields: 'is_user_follow_business' }, accessToken, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// IG Webhook Subscription — TWO Meta endpoints (this was the #100 / 403 root cause)
// ─────────────────────────────────────────────────────────────────────────────
// • graph.instagram.com/{IG_USER_ID}/subscribed_apps
//     → ONLY accepts **Instagram** webhook fields: comments, mentions, messages,
//       messaging_postbacks, messaging_seen, messaging_referral, message_reactions …
// • graph.facebook.com/{FB_PAGE_ID}/subscribed_apps
//     → ONLY accepts **Page** webhook fields: messages, messaging_postbacks,
//       message_reads, messaging_referrals, message_reactions …
//
// Sending `comments` to the **Facebook Page** endpoint produces:
//   (#100) Param subscribed_fields[0] must be one of {feed, mention, …, messages, …}
//   — got "comments".
//
// The dashboard toggles under Webhooks → **Instagram** configure app-level
// fields; programmatic subscribe still requires BOTH calls when using a Page token.
// ─────────────────────────────────────────────────────────────────────────────

/** Fields for POST … graph.instagram.com /{ig-user-id}/subscribed_apps */
const REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS = [
  'comments',
  'mentions',
  'messages',
  'messaging_postbacks',
  'messaging_seen',
  'messaging_referral',
  'message_reactions'
];

/**
 * Fields for POST … graph.facebook.com /{page-id}/subscribed_apps
 * Names must appear in Meta's Page subscribed_fields allow-list (see OAuth error text).
 * Note: Page API uses `message_reads` / `messaging_referrals` (not messaging_seen / messaging_referral).
 */
const REQUIRED_FACEBOOK_PAGE_WEBHOOK_FIELDS = [
  'messages',
  'messaging_postbacks',
  'message_reactions',
  'message_reads',
  'messaging_referrals'
];

/**
 * @deprecated Use REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS + REQUIRED_FACEBOOK_PAGE_WEBHOOK_FIELDS.
 * Union for backward-compatible API responses / docs.
 */
const REQUIRED_IG_WEBHOOK_FIELDS = Array.from(new Set([
  ...REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS,
  ...REQUIRED_FACEBOOK_PAGE_WEBHOOK_FIELDS
]));

function diffAgainstList(currentFields = [], requiredList) {
  const set = new Set(currentFields);
  return requiredList.filter(f => !set.has(f));
}

function diffInstagramGraphFields(currentFields = []) {
  return diffAgainstList(currentFields, REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS);
}

function diffFacebookPageFields(currentFields = []) {
  return diffAgainstList(currentFields, REQUIRED_FACEBOOK_PAGE_WEBHOOK_FIELDS);
}

/** @deprecated use diffInstagramGraphFields + diffFacebookPageFields */
function diffRequiredFields(currentFields = []) {
  return diffAgainstList(currentFields, REQUIRED_IG_WEBHOOK_FIELDS);
}

/**
 * Subscribe the Instagram Business Account (graph.instagram.com).
 */
async function subscribeInstagramUserToWebhooks(igUserId, accessToken, opts = {}) {
  return callGraphAPI('post', `/${igUserId}/subscribed_apps`, {
    subscribed_fields: REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS.join(',')
  }, accessToken, { ...opts, baseUrl: INSTAGRAM_GRAPH_BASE_URL });
}

/**
 * Subscribe the Facebook Page for Messenger / IG Messaging fields (graph.facebook.com).
 */
async function subscribeFacebookPageToWebhooks(fbPageId, accessToken, opts = {}) {
  return callGraphAPI('post', `/${fbPageId}/subscribed_apps`, {
    subscribed_fields: REQUIRED_FACEBOOK_PAGE_WEBHOOK_FIELDS.join(',')
  }, accessToken, opts);
}

/** @alias subscribeFacebookPageToWebhooks — legacy name used by oauth.js */
async function subscribePageToWebhooks(pageId, accessToken, opts = {}) {
  return subscribeFacebookPageToWebhooks(pageId, accessToken, opts);
}

async function getInstagramUserSubscriptions(igUserId, accessToken, opts = {}) {
  return callGraphAPI('get', `/${igUserId}/subscribed_apps`, {
    fields: 'subscribed_fields,name,category,id'
  }, accessToken, { ...opts, baseUrl: INSTAGRAM_GRAPH_BASE_URL });
}

async function getFacebookPageSubscriptions(fbPageId, accessToken, opts = {}) {
  return callGraphAPI('get', `/${fbPageId}/subscribed_apps`, {
    fields: 'subscribed_fields,name,category'
  }, accessToken, opts);
}

/** @alias getFacebookPageSubscriptions */
async function getPageSubscriptions(pageId, accessToken, opts = {}) {
  return getFacebookPageSubscriptions(pageId, accessToken, opts);
}

async function unsubscribeFacebookPageFromWebhooks(pageId, accessToken, opts = {}) {
  return callGraphAPI('delete', `/${pageId}/subscribed_apps`, {}, accessToken, opts);
}

/** @alias unsubscribeFacebookPageFromWebhooks */
async function unsubscribePageFromWebhooks(pageId, accessToken, opts = {}) {
  return unsubscribeFacebookPageFromWebhooks(pageId, accessToken, opts);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  callGraphAPI,
  sendInstagramDMv2,
  replyToCommentv2,
  checkFollowStatusv2,
  subscribeInstagramUserToWebhooks,
  subscribeFacebookPageToWebhooks,
  subscribePageToWebhooks,
  getInstagramUserSubscriptions,
  getFacebookPageSubscriptions,
  getPageSubscriptions,
  unsubscribeFacebookPageFromWebhooks,
  unsubscribePageFromWebhooks,
  diffInstagramGraphFields,
  diffFacebookPageFields,
  diffRequiredFields,
  diffAgainstList,
  REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS,
  REQUIRED_FACEBOOK_PAGE_WEBHOOK_FIELDS,
  REQUIRED_IG_WEBHOOK_FIELDS,
  INSTAGRAM_GRAPH_BASE_URL,
  GRAPH_API_VERSION,
  GRAPH_BASE_URL
};
