'use strict';

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getAppRedis } = require('../utils/core/redisFactory');
const MetaAudienceQueue = require('../models/MetaAudienceQueue');
const AdLead = require('../models/AdLead');
const PixelEvent = require('../models/PixelEvent');
const {
  buildWinningProductsWorkspace,
  buildWinningProductsCompareFromWorkspace,
} = require('../utils/commerce/winningProducts/winningProductsAggregator');
const { hashContactList } = require('../utils/commerce/winningProducts/hashContacts');
const { pushAudienceToMeta } = require('../services/metaAudiencePushService');
const { startOfDayForDateStrIST, istDateRangeStrings } = require('../utils/core/queryHelpers');

const CACHE_TTL_SEC = 300;

function tenantClientId(req) {
  if (req.user?.role === 'SUPER_ADMIN' && req.query.clientId) {
    return String(req.query.clientId).trim();
  }
  return req.user?.clientId || null;
}

function parseDays(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(90, Math.max(7, Math.round(n)));
}

function cacheKey(clientId, days) {
  return `winning_products:${clientId}:${days}`;
}

async function getCachedWorkspace(clientId, days) {
  const redis = getAppRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(cacheKey(clientId, days));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function setCachedWorkspace(clientId, days, payload) {
  const redis = getAppRedis();
  if (!redis) return;
  try {
    await redis.setex(cacheKey(clientId, days), CACHE_TTL_SEC, JSON.stringify(payload));
  } catch {
    /* ignore cache write failures */
  }
}

async function invalidateWinningProductsCache(clientId) {
  const redis = getAppRedis();
  if (!redis) return;
  try {
    for (const days of [7, 30, 90]) {
      await redis.del(cacheKey(clientId, days));
    }
  } catch {
    /* ignore */
  }
}

function assertTenant(req, res, clientId) {
  if (!clientId) {
    res.status(403).json({ success: false, message: 'Unauthorized' });
    return false;
  }
  if (req.user?.role !== 'SUPER_ADMIN' && req.user?.clientId !== clientId) {
    res.status(403).json({ success: false, message: 'Forbidden' });
    return false;
  }
  return true;
}

router.get('/workspace', protect, async (req, res) => {
  const started = Date.now();
  try {
    const clientId = tenantClientId(req);
    if (!assertTenant(req, res, clientId)) return;
    const days = parseDays(req.query.days);
    if (req.query.refresh === '1') {
      await invalidateWinningProductsCache(clientId);
    }

    let payload = await getCachedWorkspace(clientId, days);
    if (!payload) {
      payload = await buildWinningProductsWorkspace(clientId, days);
      await setCachedWorkspace(clientId, days, payload);
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Response-Time-Ms', String(Date.now() - started));
    res.json({ success: true, ...payload });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/compare', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!assertTenant(req, res, clientId)) return;
    const days = parseDays(req.query.days);
    const rawIds = String(req.query.productIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (rawIds.length < 2) {
      return res.status(400).json({ success: false, message: 'Select 2–3 products to compare' });
    }
    let workspace = await getCachedWorkspace(clientId, days);
    if (!workspace) {
      workspace = await buildWinningProductsWorkspace(clientId, days);
      await setCachedWorkspace(clientId, days, workspace);
    }
    const payload = buildWinningProductsCompareFromWorkspace(workspace, rawIds);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, ...payload });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function collectAudienceData(clientId, audienceType, since) {
  const pixelSessions = [];
  const contacts = [];

  if (audienceType === 'past_purchasers') {
    const leads = await AdLead.find({
      clientId,
      $or: [{ cartStatus: 'purchased' }, { isOrderPlaced: true }],
      updatedAt: { $gte: since },
    })
      .select('phoneNumber email firstName sessionId')
      .limit(5000)
      .lean();
    for (const l of leads) {
      if (l.sessionId) pixelSessions.push(String(l.sessionId));
      contacts.push({ phone: l.phoneNumber, email: l.email, firstName: l.firstName });
    }
    return { pixelSessions: [...new Set(pixelSessions)], contacts };
  }

  const sessionRows = await PixelEvent.aggregate([
    { $match: { clientId, timestamp: { $gte: since } } },
    {
      $addFields: {
        visitorKey: {
          $ifNull: ['$sessionId', { $ifNull: ['$metadata.visitorId', '$metadata.shopifyClientId'] }],
        },
      },
    },
    { $match: { visitorKey: { $ne: null } } },
    {
      $group: {
        _id: '$visitorKey',
        events: { $addToSet: '$eventName' },
        sessionId: { $first: '$sessionId' },
      },
    },
  ]);

  const ADD_TO_CART = new Set(['add_to_cart', 'product_added_to_cart']);

  for (const row of sessionRows) {
    const ev = new Set(row.events || []);
    let include = false;
    if (audienceType === 'store_visitors' && ev.has('page_view')) include = true;
    if (audienceType === 'product_viewers' && ev.has('product_view')) include = true;
    if (audienceType === 'cart_abandoners') {
      const hasAtc = [...ev].some((e) => ADD_TO_CART.has(e));
      const hasComplete = ev.has('checkout_completed');
      if (hasAtc && !hasComplete) include = true;
    }
    if (audienceType === 'checkout_abandoners') {
      if (ev.has('checkout_started') && !ev.has('checkout_completed')) include = true;
    }
    if (include && row.sessionId) pixelSessions.push(String(row.sessionId));
  }

  const abandonedLeads =
    audienceType === 'cart_abandoners' || audienceType === 'checkout_abandoners'
      ? await AdLead.find({
          clientId,
          cartStatus: { $in: ['abandoned', 'active'] },
          cartAbandonedAt: { $gte: since },
        })
          .select('phoneNumber email firstName sessionId')
          .limit(5000)
          .lean()
      : [];

  for (const l of abandonedLeads) {
    contacts.push({ phone: l.phoneNumber, email: l.email, firstName: l.firstName });
    if (l.sessionId) pixelSessions.push(String(l.sessionId));
  }

  return { pixelSessions: [...new Set(pixelSessions)], contacts };
}

router.post('/audiences/save', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!assertTenant(req, res, clientId)) return;

    const audienceType = String(req.body?.audienceType || '').trim();
    const allowed = [
      'store_visitors',
      'product_viewers',
      'cart_abandoners',
      'checkout_abandoners',
      'past_purchasers',
    ];
    if (!allowed.includes(audienceType)) {
      return res.status(400).json({ success: false, message: 'Invalid audience type' });
    }

    const periodDays = parseDays(req.body?.periodDays || req.query.days || 30);
    const { start: periodStart } = istDateRangeStrings(periodDays);
    const since = startOfDayForDateStrIST(periodStart);

    const sizeAtSave = Number(req.body?.sizeAtSave) || 0;
    const { pixelSessions, contacts } = await collectAudienceData(clientId, audienceType, since);
    const hashedContacts = hashContactList(contacts);

    const doc = await MetaAudienceQueue.create({
      clientId,
      audienceType,
      productId: req.body?.productId || null,
      sizeAtSave: sizeAtSave || pixelSessions.length || hashedContacts.length,
      hashedContacts,
      pixelSessions: pixelSessions.slice(0, 10000),
      savedByUserId: req.user?._id || req.user?.id,
      periodDays,
      criteria: req.body?.criteria || {},
    });

    await invalidateWinningProductsCache(clientId);

    res.json({
      success: true,
      audience: {
        id: doc._id,
        audienceType: doc.audienceType,
        sizeAtSave: doc.sizeAtSave,
        status: doc.status,
        savedAt: doc.savedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/audiences', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!assertTenant(req, res, clientId)) return;

    const rows = await MetaAudienceQueue.find({ clientId, status: { $ne: 'expired' } })
      .sort({ savedAt: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, audiences: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/audiences/:id', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!assertTenant(req, res, clientId)) return;

    const result = await MetaAudienceQueue.deleteOne({ _id: req.params.id, clientId });
    if (!result.deletedCount) {
      return res.status(404).json({ success: false, message: 'Audience not found' });
    }
    await invalidateWinningProductsCache(clientId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/audiences/:id/push', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!assertTenant(req, res, clientId)) return;
    const result = await pushAudienceToMeta(req.params.id, clientId);
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/notifications', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!assertTenant(req, res, clientId)) return;
    const Client = require('../models/Client');
    const client = await Client.findOne({ clientId }).select('insightsNotifications').lean();
    res.json({
      success: true,
      insightsNotifications: client?.insightsNotifications || {
        daily: false,
        weekly: true,
        realtimeAlerts: true,
        channels: { whatsapp: true, email: true, dashboard: true },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch('/notifications', protect, async (req, res) => {
  try {
    const clientId = tenantClientId(req);
    if (!assertTenant(req, res, clientId)) return;
    const Client = require('../models/Client');
    const body = req.body?.insightsNotifications || req.body || {};
    const update = {};
    if (typeof body.daily === 'boolean') update['insightsNotifications.daily'] = body.daily;
    if (typeof body.weekly === 'boolean') update['insightsNotifications.weekly'] = body.weekly;
    if (typeof body.realtimeAlerts === 'boolean') {
      update['insightsNotifications.realtimeAlerts'] = body.realtimeAlerts;
    }
    if (body.channels && typeof body.channels === 'object') {
      for (const key of ['whatsapp', 'email', 'dashboard']) {
        if (typeof body.channels[key] === 'boolean') {
          update[`insightsNotifications.channels.${key}`] = body.channels[key];
        }
      }
    }
    const client = await Client.findOneAndUpdate(
      { clientId },
      { $set: update },
      { new: true }
    )
      .select('insightsNotifications')
      .lean();
    res.json({ success: true, insightsNotifications: client?.insightsNotifications });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
