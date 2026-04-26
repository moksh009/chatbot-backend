"use strict";

const axios = require('axios');
const log = require('./logger')('IGGraphAPI');

const GRAPH_API_VERSION = 'v19.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

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
  const url = endpoint.startsWith('http') ? endpoint : `${GRAPH_BASE_URL}${endpoint}`;
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

/**
 * Subscribe page to webhook events (comments, mentions, messages)
 */
async function subscribePageToWebhooks(pageId, accessToken, opts = {}) {
  return callGraphAPI('post', `/${pageId}/subscribed_apps`, {
    subscribed_fields: 'comments,mentions,messages'
  }, accessToken, opts);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  callGraphAPI,
  sendInstagramDMv2,
  replyToCommentv2,
  checkFollowStatusv2,
  subscribePageToWebhooks,
  GRAPH_API_VERSION,
  GRAPH_BASE_URL
};
