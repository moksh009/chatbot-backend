'use strict';

/**
 * waClickTrackingService.js
 *
 * WhatsApp CTA URL button click tracking.
 *
 * Background: WhatsApp static URL buttons (type: cta_url) NEVER generate a
 * webhook when tapped — confirmed by Meta developer docs and all major BSPs
 * (Kaleyra, Fyno, Sprinklr, SAP). The only way to capture a click is to route
 * the tap through your own redirect server using a dynamic URL button (template
 * must use a variable in the button URL, e.g. {{1}}).
 *
 * Pattern (identical to emailTrackingService.js for email clicks):
 *   1. At send time: buildWaClickTrackUrl(sequenceId, stepIdx, clientId, realUrl)
 *      → returns a short URL like GET /api/wa/track/click/:token
 *   2. This URL is set as the dynamic button URL when sending the WA template.
 *   3. When recipient taps the button, WhatsApp opens this URL in their browser.
 *   4. Our endpoint (routes/waTracking.js) logs the click and 302-redirects
 *      to the real destination URL.
 *
 * Important constraints:
 *   - Only works with DYNAMIC URL buttons (variable in button URL). Templates
 *     using a static URL button are a permanent blind spot; they cannot be
 *     retrofitted without Meta re-approval.
 *   - Tokens are signed with JWT_SECRET (same secret as emailTrackingService).
 */

const jwt = require('jsonwebtoken');
const FollowUpSequence = require('../../models/FollowUpSequence');

function trackingSecret() {
  return process.env.JWT_SECRET || 'topedge-wa-tracking-dev-only';
}

function getTrackingBaseUrl() {
  return String(
    process.env.PUBLIC_BASE_URL ||
    process.env.BACKEND_URL ||
    'https://api.topedgeai.com'
  ).replace(/\/$/, '');
}

function signWaClickToken(payload, expiresIn = '90d') {
  return jwt.sign(payload, trackingSecret(), { expiresIn });
}

function verifyWaClickToken(token) {
  try {
    return jwt.verify(String(token || ''), trackingSecret());
  } catch {
    return null;
  }
}

/**
 * Generate a tracked URL for a WA dynamic URL button.
 *
 * @param {string} sequenceId  - FollowUpSequence _id (string)
 * @param {number} stepIdx     - Zero-based step index
 * @param {string} clientId    - Tenant client ID
 * @param {string} originalUrl - The real destination URL
 * @returns {string} A URL pointing at GET /api/wa/track/click/:token
 */
function buildWaClickTrackUrl(sequenceId, stepIdx, clientId, originalUrl) {
  const token = signWaClickToken({
    sequenceId: String(sequenceId),
    stepIdx: Number(stepIdx),
    clientId: String(clientId),
    url: String(originalUrl),
    type: 'wa_click',
  });
  return `${getTrackingBaseUrl()}/api/wa/track/click/${encodeURIComponent(token)}`;
}

/**
 * Record a click on a journey step's URL button.
 * Called by the redirect endpoint after token verification.
 *
 * Writes clickedAt + clickType:'link' on the matching step.
 *
 * @returns {{ success: boolean, redirectUrl: string }}
 */
async function recordWaClick({ sequenceId, stepIdx, clientId, url, req = {} }) {
  const now = new Date();
  const path = `steps.${Number(stepIdx)}`;

  try {
    const filter = { _id: sequenceId };
    if (clientId) filter.clientId = clientId;

    const result = await FollowUpSequence.updateOne(filter, {
      $set: {
        [`${path}.clickedAt`]: now,
        [`${path}.clickType`]: 'link',
      },
    });

    return { success: result.modifiedCount > 0, redirectUrl: url };
  } catch (err) {
    const log = require('../core/logger')('waClickTracking');
    log.warn('recordWaClick failed', {
      sequenceId,
      stepIdx,
      clientId,
      message: err?.message,
    });
    return { success: false, redirectUrl: url };
  }
}

module.exports = {
  buildWaClickTrackUrl,
  verifyWaClickToken,
  recordWaClick,
  getTrackingBaseUrl,
};
