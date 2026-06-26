/**
 * Public storefront opt-in endpoints — no Bearer auth (embed key only).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const optInService = require('../services/optInToolsService');
const { subscribe, capturePhone } = require('../services/optInSubscribeService');

const router = express.Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again shortly.' },
});

const subscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests. Try again shortly.' },
});

router.get('/config', publicLimiter, async (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ success: false, reason: 'missing_key' });
    const payload = await optInService.getPublicConfig(key);
    if (!payload.success) return res.status(404).json(payload);
    return res.json(payload);
  } catch (e) {
    console.error('[publicOptIn/config]', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/impression', publicLimiter, async (req, res) => {
  try {
    const key = String(req.body.embedKey || req.body.key || '').trim();
    const toolId = String(req.body.toolId || '').trim();
    if (!key || !toolId) {
      return res.status(400).json({ success: false, message: 'embedKey and toolId required' });
    }
    const cfg = await optInService.getPublicConfig(key);
    if (!cfg.success) return res.status(404).json({ success: false, message: 'Unknown key' });
    const { recordImpression } = require('../services/optInAnalyticsService');
    const isMobile =
      req.body.isMobile === true ||
      req.body.isMobile === 'true' ||
      String(req.body.device || '').toLowerCase() === 'mobile';
    await recordImpression(cfg.clientId, toolId, {
      pageUrl: req.body.pageUrl || req.body.page_url,
      isMobile,
    });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/subscribe', subscribeLimiter, async (req, res) => {
  try {
    const result = await subscribe({
      embedKey: req.body.embedKey || req.body.key,
      phone: req.body.phone,
      consent: req.body.consent,
      toolId: req.body.toolId,
      pageUrl: req.body.pageUrl || req.body.page_url,
      visitorId: req.body.visitorId,
      name: req.body.name,
      email: req.body.email,
      dateOfBirth: req.body.dateOfBirth || req.body.dob,
      req,
    });
    return res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (e) {
    console.error('[publicOptIn/subscribe]', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/capture-phone', subscribeLimiter, async (req, res) => {
  try {
    const result = await capturePhone({
      embedKey: req.body.embedKey || req.body.key,
      phone: req.body.phone,
      consent: req.body.consent,
      toolId: req.body.toolId,
      pageUrl: req.body.pageUrl || req.body.page_url,
      visitorId: req.body.visitorId,
      req,
    });
    return res.status(result.success ? 200 : result.status || 400).json(result);
  } catch (e) {
    console.error('[publicOptIn/capture-phone]', e);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/bestsellers', publicLimiter, async (req, res) => {
  try {
    const key = String(req.query.key || '').trim();
    if (!key) return res.status(400).json({ success: false, message: 'key required' });
    const cfg = await optInService.getPublicConfig(key);
    if (!cfg.success) return res.status(404).json({ success: false, message: 'Unknown key' });

    let products = [];
    try {
      const { buildWinningProductsWorkspace } = require('../utils/commerce/winningProducts/winningProductsAggregator');
      const ws = await buildWinningProductsWorkspace(cfg.clientId, 30);
      products = (ws?.products || ws?.winningProducts || []).slice(0, 3).map((p) => ({
        title: p.title || p.name,
        imageUrl: p.imageUrl || p.image || '',
        price: p.price || p.revenue || '',
        url: p.url || p.productUrl || '',
      }));
    } catch {
      products = [];
    }
    return res.json({ success: true, products });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
