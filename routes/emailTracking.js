'use strict';

const express = require('express');
const router = express.Router();
const {
  TRANSPARENT_GIF,
  verifyTrackingToken,
  recordEmailOpen,
  recordEmailClick,
  processEmailUnsubscribe,
  renderUnsubscribePage,
  renderUnsubscribeSuccessPage,
} = require('../utils/core/emailTrackingService');
const MessageEnvelope = require('../models/MessageEnvelope');

router.get('/track/open/:token', async (req, res) => {
  const raw = String(req.params.token || '');
  const token = raw.replace(/\.gif$/i, '');
  const decoded = verifyTrackingToken(token);

  if (decoded?.envelopeId && decoded?.clientId && decoded.type === 'open') {
    try {
      await recordEmailOpen(decoded.envelopeId, decoded.clientId, req);
    } catch (_) {
      /* recordEmailOpen handles + logs internally */
    }
  }

  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
  });
  res.status(200).send(TRANSPARENT_GIF);
});

router.get('/track/click/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const decoded = verifyTrackingToken(token);

  if (!decoded || decoded.type !== 'click' || !decoded.url) {
    return res.status(400).send('Invalid tracking link.');
  }

  await recordEmailClick(decoded.envelopeId, decoded.clientId, decoded.url, req);
  return res.redirect(302, decoded.url);
});

router.get('/unsubscribe/:token', async (req, res) => {
  const token = String(req.params.token || '');
  const result = await processEmailUnsubscribe(token, req);

  if (!result.success) {
    return res.status(result.status).send(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribe</title></head><body style="font-family:system-ui;padding:40px;color:#0f172a"><h3>${result.message}</h3></body></html>`
    );
  }

  return res.send(renderUnsubscribeSuccessPage());
});

router.post('/unsubscribe', express.urlencoded({ extended: false }), async (req, res) => {
  const token = String(req.body?.token || req.query?.token || '').trim();
  const result = await processEmailUnsubscribe(token, req);

  if (!result.success) {
    if (req.headers.accept?.includes('application/json')) {
      return res.status(result.status).json({ success: false, message: result.message });
    }
    return res.status(result.status).send(`<h3>${result.message}</h3>`);
  }

  if (req.headers.accept?.includes('application/json')) {
    return res.json({ success: true, message: result.message });
  }
  return res.send(renderUnsubscribeSuccessPage());
});

module.exports = router;
