'use strict';

/**
 * routes/waTracking.js
 *
 * WhatsApp CTA URL button click-tracking redirect endpoint.
 * Mounted at /api/wa in index.js.
 *
 * GET /api/wa/track/click/:token
 *   - Decodes and verifies the JWT token.
 *   - Calls recordWaClick to log the click on the FollowUpSequence step.
 *   - 302-redirects the customer to the real destination URL.
 *   - Always redirects (even on errors) so the customer experience is unaffected.
 */

const express = require('express');
const router = express.Router();
const {
  verifyWaClickToken,
  recordWaClick,
} = require('../utils/wa/waClickTrackingService');

router.get('/track/click/:token', async (req, res) => {
  const { token } = req.params;
  const fallbackUrl = '/';

  const decoded = verifyWaClickToken(decodeURIComponent(token));
  if (!decoded || decoded.type !== 'wa_click' || !decoded.url) {
    return res.redirect(302, fallbackUrl);
  }

  // Log the click non-blocking — redirect first, then record
  const { redirectUrl } = await recordWaClick({
    sequenceId: decoded.sequenceId,
    stepIdx: decoded.stepIdx,
    clientId: decoded.clientId,
    url: decoded.url,
    req,
  });

  return res.redirect(302, redirectUrl || fallbackUrl);
});

module.exports = router;
