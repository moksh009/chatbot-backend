"use strict";

/**
 * pushRoutes.js — Phase 26 Track 6: Web Push Notification Routes
 * Endpoints:
 *   GET    /api/push/vapid-public-key  → returns VAPID public key
 *   POST   /api/push/subscribe         → save/update PushSubscription
 *   DELETE /api/push/unsubscribe       → remove PushSubscription
 */

const express          = require('express');
const router           = express.Router();
const PushSubscription = require('../models/PushSubscription');
const { authenticate } = require('../middleware/auth');

// ── GET /api/push/vapid-public-key ───────────────────────
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return res.status(503).json({ success: false, error: 'VAPID not configured' });
  }
  res.json({ success: true, key });
});

// ── POST /api/push/subscribe ──────────────────────────────
router.post('/subscribe', authenticate, async (req, res) => {
  try {
    const { endpoint, keys, userAgent } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ success: false, error: 'Invalid subscription object' });
    }

    const clientId = req.user?.clientId || req.body.clientId;
    const agentId  = req.user?._id;

    await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        clientId,
        agentId,
        endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        userAgent: userAgent || req.headers['user-agent'] || '',
        lastUsedAt: new Date()
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Subscribed to push notifications' });
  } catch (err) {
    console.error('[Push] Subscribe error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DELETE /api/push/unsubscribe ───────────────────────────
router.delete('/unsubscribe', authenticate, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await PushSubscription.findOneAndDelete({ endpoint });
    } else {
      // Remove all subscriptions for this agent
      await PushSubscription.deleteMany({ agentId: req.user?._id });
    }
    res.json({ success: true, message: 'Unsubscribed' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
