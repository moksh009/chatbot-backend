"use strict";

// IG Automation — CRUD Controller
// =================================
// All routes here are mounted under /api/ig-automation by routes/igAutomationRoutes.js
// and protected by the global `protect` auth middleware.
//
// Hard rules (every handler must follow these — that is what fixed the 503):
//   1. Every handler is wrapped in try/catch and returns JSON, never crashes.
//   2. Webhook subscription side-effects are best-effort and never fail the request.
//   3. All "live" reads filter by { deletedAt: null } so soft-deleted automations
//      stay out of the UI but remain queryable for historical analytics.
//   4. Stats are incremented atomically by the webhook processor — never recomputed
//      synchronously in this controller.

const express = require('express');
const router = express.Router();

const IGAutomation = require('../../models/IGAutomation');
const IGAutomationSession = require('../../models/IGAutomationSession');
const Client = require('../../models/Client');
const {
  subscribeInstagramUserToWebhooks,
  subscribeFacebookPageToWebhooks,
  getInstagramUserSubscriptions,
  getFacebookPageSubscriptions,
  diffInstagramGraphFields,
  diffFacebookPageFields,
  REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS,
  REQUIRED_FACEBOOK_PAGE_WEBHOOK_FIELDS,
  REQUIRED_IG_WEBHOOK_FIELDS
} = require('../../utils/igGraphApi');
const { validateAutomationMessages } = require('../../utils/igTextValidation');
const { decrypt } = require('../../utils/encryption');
const log = require('../../utils/logger')('IGAutoCRUD');

// Resolve Page Access Token + BOTH IDs Meta needs for webhooks:
//   • fbPageId   → graph.facebook.com/{fbPageId}/subscribed_apps (Messenger/Page fields only)
//   • igUserId   → graph.instagram.com/{igUserId}/subscribed_apps (comments, mentions, …)
//
// OAuth historically wrote igDetails.id into `instagramPageId` — that value is the
// **Instagram Business Account ID**, NOT the Facebook Page ID. Never send IG IDs to
// the Page subscribed_apps endpoint or Meta returns 403 / (#100) invalid fields.
function readClientIgCreds(client) {
  if (!client) return { rawToken: null, fbPageId: null, igUserId: null };
  const rawToken =
    client.instagramAccessToken ||
    client.igAccessToken ||
    client.social?.instagram?.accessToken ||
    null;

  const fbPageId =
    client.instagramFbPageId ||
    client.social?.instagram?.fbPageId ||
    null;

  let igUserId =
    client.igUserId ||
    client.instagramUserId ||
    null;

  if (!igUserId) {
    const legacyIg =
      client.instagramPageId ||
      client.social?.instagram?.pageId ||
      null;
    if (legacyIg && fbPageId && String(legacyIg) === String(fbPageId)) {
      igUserId = null;
    } else if (legacyIg) {
      igUserId = legacyIg;
    }
  }
  if (!igUserId && client.igPageId && (!fbPageId || String(client.igPageId) !== String(fbPageId))) {
    igUserId = client.igPageId;
  }

  return { rawToken, fbPageId, igUserId };
}

// Best-effort, auto-healing webhook subscription — **two Meta Graph hosts**.
//
// 1) graph.instagram.com/{ig-user-id}/subscribed_apps → comments, mentions, …
// 2) graph.facebook.com/{fb-page-id}/subscribed_apps → messages, messaging_*, …
//
// MUST NOT throw — every caller expects soft-fail.
//
// Returns: { ok, reason, subscribedFields, missingFields, instagram, page, action }
async function ensureWebhookSubscription(clientId, { force = false } = {}) {
  const result = {
    ok: false,
    reason: null,
    subscribedFields: [],
    missingFields: [],
    instagram: { id: null, subscribedFields: [], missingFields: REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS.slice() },
    page: { id: null, subscribedFields: [], missingFields: REQUIRED_FACEBOOK_PAGE_WEBHOOK_FIELDS.slice() },
    action: 'none'
  };

  const pickAppSubscription = (subsRes) => {
    const apps = subsRes?.data || [];
    const myAppId = process.env.FACEBOOK_APP_ID || process.env.META_APP_ID;
    const mine = myAppId
      ? apps.find(a =>
        String(a?.id || a?.app_id || a?.name || '') === String(myAppId))
      : null;
    return (mine?.subscribed_fields) || apps.flatMap(a => a?.subscribed_fields || []) || [];
  };

  try {
    const client = await Client.findOne({ clientId });
    if (!client) {
      result.reason = 'client_not_found';
      return result;
    }

    const { rawToken, fbPageId, igUserId } = readClientIgCreds(client);
    if (!rawToken) {
      result.reason = 'missing_credentials';
      await Client.findOneAndUpdate({ clientId }, {
        $set: { igWebhookLastCheckedAt: new Date(), igWebhookLastError: 'missing_credentials' }
      });
      return result;
    }
    if (!igUserId && !fbPageId) {
      result.reason = 'missing_ids';
      await Client.findOneAndUpdate({ clientId }, {
        $set: {
          igWebhookLastCheckedAt: new Date(),
          igWebhookLastError: 'Missing both Instagram Business Account ID and Facebook Page ID. Reconnect Instagram in Settings → Integrations.'
        }
      });
      return result;
    }

    const accessToken = decrypt(rawToken);
    if (!accessToken) {
      result.reason = 'token_decrypt_failed';
      return result;
    }

    result.instagram.id = igUserId || null;
    result.page.id = fbPageId || null;

    let igFields = [];
    let pageFields = [];

    if (igUserId) {
      try {
        const subsRes = await getInstagramUserSubscriptions(igUserId, accessToken, { clientId });
        igFields = pickAppSubscription(subsRes);
      } catch (readErr) {
        log.warn(`[Webhook] Could not read Instagram-graph subscription for client=${clientId}: ${readErr.message}`);
      }
    }
    if (fbPageId) {
      try {
        const subsRes = await getFacebookPageSubscriptions(fbPageId, accessToken, { clientId });
        pageFields = pickAppSubscription(subsRes);
      } catch (readErr) {
        log.warn(`[Webhook] Could not read Page subscription for client=${clientId}: ${readErr.message}`);
      }
    }

    result.instagram.subscribedFields = igFields;
    result.page.subscribedFields = pageFields;

    // If an ID is absent from the Client doc, treat that side as "all missing" only
    // for Instagram (comments require igUserId). Page subscription is optional if
    // the tenant truly has no linked FB Page (rare); do not block on empty fbPageId.
    const missingIg = igUserId
      ? diffInstagramGraphFields(igFields)
      : REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS.slice();
    const missingPage = fbPageId
      ? diffFacebookPageFields(pageFields)
      : [];

    result.instagram.missingFields = missingIg;
    result.page.missingFields = fbPageId ? missingPage : [];
    result.missingFields = [
      ...missingIg.map(f => `instagram:${f}`),
      ...missingPage.map(f => `page:${f}`)
    ];
    result.subscribedFields = Array.from(new Set([...igFields, ...pageFields]));

    const needsIg = Boolean(igUserId && (missingIg.length > 0 || force));
    const needsPage = Boolean(fbPageId && (missingPage.length > 0 || force));
    const fullyDone =
      (!igUserId || missingIg.length === 0) &&
      (!fbPageId || missingPage.length === 0) &&
      !force;

    if (fullyDone) {
      result.ok = true;
      result.reason = 'already_subscribed';
      result.action = 'noop';
      await Client.findOneAndUpdate({ clientId }, {
        $set: {
          igWebhookSubscribed: true,
          igSubscribedFields: result.subscribedFields,
          igWebhookLastCheckedAt: new Date(),
          igWebhookLastError: null
        }
      });
      return result;
    }

    log.info(`[Webhook] Re-subscribe client=${clientId} ig=${igUserId || '—'} fbPage=${fbPageId || '—'} needsIg=${needsIg} needsPage=${needsPage}`);

    if (needsIg && igUserId) {
      await subscribeInstagramUserToWebhooks(igUserId, accessToken, { clientId });
    }
    if (needsPage && fbPageId) {
      await subscribeFacebookPageToWebhooks(fbPageId, accessToken, { clientId });
    }

    let igConfirmed = igFields;
    let pageConfirmed = pageFields;
    try {
      if (igUserId) {
        const confirmIg = await getInstagramUserSubscriptions(igUserId, accessToken, { clientId });
        igConfirmed = pickAppSubscription(confirmIg);
      }
      if (fbPageId) {
        const confirmPg = await getFacebookPageSubscriptions(fbPageId, accessToken, { clientId });
        pageConfirmed = pickAppSubscription(confirmPg);
      }
    } catch (_e) { /* non-fatal */ }

    const stillIg = igUserId
      ? diffInstagramGraphFields(igConfirmed)
      : REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS.slice();
    const stillPage = fbPageId
      ? diffFacebookPageFields(pageConfirmed)
      : [];
    const stillMissing = [
      ...stillIg.map(f => `instagram:${f}`),
      ...stillPage.map(f => `page:${f}`)
    ];

    result.instagram.subscribedFields = igConfirmed;
    result.page.subscribedFields = pageConfirmed;
    result.instagram.missingFields = stillIg;
    result.page.missingFields = stillPage;
    result.subscribedFields = Array.from(new Set([...igConfirmed, ...pageConfirmed]));
    result.missingFields = stillMissing;

    const ok = stillMissing.length === 0;
    await Client.findOneAndUpdate({ clientId }, {
      $set: {
        igWebhookSubscribed: ok,
        igSubscribedFields: result.subscribedFields,
        igWebhookLastCheckedAt: new Date(),
        igWebhookLastError: ok ? null : `Missing after subscribe: ${stillMissing.join(', ')}. For Live-mode tenants, request Advanced Access for instagram_manage_comments / instagram_manage_messages in App Review.`
      }
    });

    result.ok = ok;
    result.action = 'subscribed';
    if (!ok) {
      result.reason = `Meta still reports missing: ${stillMissing.join(', ')}.`;
    }
    log.info(`[Webhook] client=${clientId} ok=${ok} merged=[${result.subscribedFields.join(',')}]`);
    return result;
  } catch (err) {
    log.warn(`[Webhook] Subscription failed for client=${clientId}: ${err.message}`);
    await Client.findOneAndUpdate({ clientId }, {
      $set: { igWebhookLastCheckedAt: new Date(), igWebhookLastError: err.message }
    }).catch(() => {});
    result.reason = err.message;
    return result;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ig-automation?clientId=X&type=comment_to_dm
// Returns active (not deleted, not archived) automations for the panel.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { clientId, type } = req.query;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required' });

    const filter = {
      clientId,
      deletedAt: null,
      status: { $ne: 'archived' }
    };
    if (type) filter.type = type;

    const automations = await IGAutomation.find(filter).sort({ createdAt: -1 }).lean();
    res.status(200).json({ success: true, automations });
  } catch (error) {
    log.error('Fetch error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch automations' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ig-automation/stats?clientId=X&type=comment_to_dm
// Aggregated counters for the panel header. Reads from automation.stats which
// the webhook processor increments atomically — these are write-time numbers,
// not recomputed on read.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const { clientId, type } = req.query;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required' });

    const filter = { clientId, deletedAt: null, status: { $ne: 'archived' } };
    if (type) filter.type = type;

    const result = await IGAutomation.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalActive: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          totalDmsSent: { $sum: '$stats.totalDmsSent' },
          totalCommentReplies: { $sum: '$stats.totalCommentReplies' },
          totalTriggered: { $sum: '$stats.totalTriggered' },
          totalFollowGatePassed: { $sum: '$stats.totalFollowGatePassed' },
          totalFollowGateFailed: { $sum: '$stats.totalFollowGateFailed' }
        }
      }
    ]);

    const stats = result[0] || {
      totalActive: 0,
      totalDmsSent: 0,
      totalCommentReplies: 0,
      totalTriggered: 0,
      totalFollowGatePassed: 0,
      totalFollowGateFailed: 0
    };

    res.status(200).json({ success: true, stats });
  } catch (error) {
    log.error('Stats error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ig-automation/analytics?clientId=X[&startDate&endDate]
// Section-level analytics for the IG dashboard.
// Active counts come from the live IGAutomation collection.
// Triggered/DM/Reply totals come from automation.stats counters.
// Optional date range filters narrow stats over IGAutomationSession (the events
// log) so the dashboard can support "last 7 days" style filtering without
// touching write-time counters.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const { clientId, startDate, endDate } = req.query;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required' });

    const liveFilterBase = { clientId, deletedAt: null, status: { $ne: 'archived' } };

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    // For period-bound counts, we use IGAutomationSession (every triggered automation
    // creates one session document). actionTaken is filled by the message dispatcher.
    const sessionMatch = (type) => {
      const m = { clientId };
      if (hasDateFilter) m.createdAt = dateFilter;
      // join on automation.type via $lookup below
      return m;
    };

    const aggregateCommentLifetime = await IGAutomation.aggregate([
      { $match: { ...liveFilterBase, type: 'comment_to_dm' } },
      {
        $group: {
          _id: null,
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          triggered: { $sum: '$stats.totalTriggered' },
          dmsSent: { $sum: '$stats.totalDmsSent' },
          replies: { $sum: '$stats.totalCommentReplies' }
        }
      }
    ]);

    const aggregateStoryLifetime = await IGAutomation.aggregate([
      { $match: { ...liveFilterBase, type: 'story_to_dm' } },
      {
        $group: {
          _id: null,
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          triggered: { $sum: '$stats.totalTriggered' },
          dmsSent: { $sum: '$stats.totalDmsSent' }
        }
      }
    ]);

    const commentBase = aggregateCommentLifetime[0] || { active: 0, triggered: 0, dmsSent: 0, replies: 0 };
    const storyBase = aggregateStoryLifetime[0] || { active: 0, triggered: 0, dmsSent: 0 };

    // Date-filtered overrides via IGAutomationSession join with automation type.
    // Sessions are pruned automatically by the TTL index after 24h, so date filters
    // beyond that window will fall through to lifetime stats. That's intentional —
    // we have no event store yet and this gives correct "today" / "yesterday" reads.
    let commentTriggeredScoped = commentBase.triggered;
    let storyTriggeredScoped = storyBase.triggered;

    if (hasDateFilter) {
      const scopedComment = await IGAutomationSession.aggregate([
        { $match: sessionMatch() },
        {
          $lookup: {
            from: 'igautomations',
            localField: 'automationId',
            foreignField: '_id',
            as: 'automation'
          }
        },
        { $unwind: '$automation' },
        { $match: { 'automation.type': 'comment_to_dm', 'automation.clientId': clientId } },
        { $count: 'count' }
      ]);
      const scopedStory = await IGAutomationSession.aggregate([
        { $match: sessionMatch() },
        {
          $lookup: {
            from: 'igautomations',
            localField: 'automationId',
            foreignField: '_id',
            as: 'automation'
          }
        },
        { $unwind: '$automation' },
        { $match: { 'automation.type': 'story_to_dm', 'automation.clientId': clientId } },
        { $count: 'count' }
      ]);
      commentTriggeredScoped = scopedComment[0]?.count || 0;
      storyTriggeredScoped = scopedStory[0]?.count || 0;
    }

    return res.status(200).json({
      success: true,
      commentToDm: {
        active: commentBase.active,
        triggered: commentTriggeredScoped,
        dmsSent: commentBase.dmsSent,
        replies: commentBase.replies
      },
      storyToDm: {
        active: storyBase.active,
        triggered: storyTriggeredScoped,
        dmsSent: storyBase.dmsSent
      }
    });
  } catch (err) {
    log.error('Analytics error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch analytics' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ig-automation/activity?clientId=X&limit=50
// Inbox activity log — IGAutomationSession is the per-trigger record.
// IGSIDs are masked before being returned (privacy / audit-friendly).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/activity', async (req, res) => {
  try {
    const { clientId, limit = 50, automationId, actionType } = req.query;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required' });

    const filter = { clientId };
    if (automationId) filter.automationId = automationId;
    if (actionType) filter.actionTaken = actionType;

    const sessions = await IGAutomationSession.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit, 10))
      .lean();

    const maskedSessions = sessions.map(s => ({
      ...s,
      igsid: s.igsid ? `${s.igsid.substring(0, 4)}...${s.igsid.substring(s.igsid.length - 4)}` : 'unknown'
    }));

    res.status(200).json({ success: true, activity: maskedSessions });
  } catch (error) {
    log.error('Activity error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch activity' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ig-automation/:id/stats
// Per-automation counts. Mirrors the section analytics, scoped to one row.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id/stats', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const automation = await IGAutomation.findById(req.params.id).lean();
    if (!automation) return res.status(404).json({ success: false, error: 'Automation not found' });

    let triggered = automation.stats?.totalTriggered || 0;
    const dmsSent = automation.stats?.totalDmsSent || 0;
    const replies = automation.stats?.totalCommentReplies || 0;

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    if (Object.keys(dateFilter).length > 0) {
      const sessionFilter = { automationId: automation._id, createdAt: dateFilter };
      triggered = await IGAutomationSession.countDocuments(sessionFilter);
    }

    res.status(200).json({
      success: true,
      stats: { triggered, dmsSent, replies }
    });
  } catch (err) {
    log.error('Per-automation stats error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch automation stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ig-automation
// Creates a new automation. If status === 'active', also kicks off webhook
// subscription as a non-fatal side-effect.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const payload = req.body || {};
    const { clientId, type, name, status } = payload;

    if (!clientId || !type || !name) {
      return res.status(400).json({ success: false, error: 'clientId, type, and name are required' });
    }
    if (!['comment_to_dm', 'story_to_dm'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Invalid automation type' });
    }
    if (name.length > 100) {
      return res.status(400).json({ success: false, error: 'Name must be 100 characters or less' });
    }

    if (status === 'active') {
      const client = await Client.findOne({ clientId }).lean();
      const { rawToken } = readClientIgCreds(client);
      if (!rawToken) {
        return res.status(422).json({
          success: false,
          error: 'Your Instagram account is not connected. Go to Settings → Integrations → Instagram to connect.'
        });
      }
      if (!payload.flow?.openingDm) {
        return res.status(400).json({ success: false, error: 'Opening DM message is required for active automations' });
      }
    }

    const validationErrors = validateAutomationMessages(payload);
    if (validationErrors.length > 0) {
      return res.status(422).json({ success: false, errors: validationErrors });
    }

    const automation = new IGAutomation({
      ...payload,
      status: status || 'draft',
      deletedAt: null,
      stats: {
        totalTriggered: 0,
        totalDmsSent: 0,
        totalCommentReplies: 0,
        totalFollowGatePassed: 0,
        totalFollowGateFailed: 0
      }
    });

    await automation.save();

    if (status === 'active') {
      // Best-effort. Webhook reg failures should never block automation creation.
      ensureWebhookSubscription(clientId).catch(err =>
        log.warn(`[POST] Webhook subscription background error: ${err.message}`)
      );
    }

    res.status(201).json({ success: true, automation });
  } catch (error) {
    log.error('Create error:', error.message, error.stack);
    res.status(500).json({ success: false, error: 'Failed to create automation' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/ig-automation/:id
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { name, status, trigger, flow, targeting, storyTrigger } = req.body || {};

    const updateData = { updatedAt: new Date() };
    if (name !== undefined) updateData.name = name;
    if (status !== undefined) updateData.status = status;
    if (trigger !== undefined) updateData.trigger = trigger;
    if (flow !== undefined) updateData.flow = flow;
    if (targeting !== undefined) {
      // mediaId is set by the post-preview controller server-side. Don't accept
      // a client-supplied override on edit — that would let someone retarget an
      // automation to a different post by spoofing the field.
      const { mediaId, ...safeTargeting } = targeting;
      updateData.targeting = safeTargeting;
    }
    if (storyTrigger !== undefined) updateData.storyTrigger = storyTrigger;

    const existingAuto = await IGAutomation.findOne({
      _id: req.params.id,
      deletedAt: null
    }).lean();
    if (!existingAuto) return res.status(404).json({ success: false, error: 'Automation not found' });

    const currentStatus = status !== undefined ? status : existingAuto.status;
    const isActivating = currentStatus === 'active';

    if (flow !== undefined || trigger !== undefined || status !== undefined) {
      const tempPayload = {
        flow: flow || existingAuto.flow || {},
        trigger: trigger || existingAuto.trigger || {},
        status: currentStatus
      };
      const validationErrors = validateAutomationMessages(tempPayload);
      if (validationErrors.length > 0) {
        return res.status(422).json({ success: false, errors: validationErrors });
      }
    }

    if (isActivating) {
      const client = await Client.findOne({ clientId: existingAuto.clientId }).lean();
      const { rawToken } = readClientIgCreds(client);
      if (!rawToken) {
        return res.status(422).json({
          success: false,
          error: 'Your Instagram account is not connected. Go to Settings → Integrations → Instagram to connect.'
        });
      }
    }

    const updated = await IGAutomation.findOneAndUpdate(
      { _id: req.params.id, deletedAt: null },
      { $set: updateData },
      { new: true }
    );

    if (!updated) return res.status(404).json({ success: false, error: 'Automation not found' });

    if (isActivating) {
      ensureWebhookSubscription(existingAuto.clientId).catch(err =>
        log.warn(`[PATCH] Webhook subscription background error: ${err.message}`)
      );
    }

    res.status(200).json({ success: true, automation: updated });
  } catch (error) {
    log.error('Update error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update automation' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/ig-automation/:id/toggle
// Active <-> paused. The fix for the 503: webhook subscription is best-effort
// and never blocks the response. The handler is fully wrapped in try/catch.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/toggle', async (req, res) => {
  try {
    const auto = await IGAutomation.findOne({
      _id: req.params.id,
      deletedAt: null
    });
    if (!auto) return res.status(404).json({ success: false, error: 'Automation not found' });

    const newStatus = auto.status === 'active' ? 'paused' : 'active';

    if (newStatus === 'active') {
      const client = await Client.findOne({ clientId: auto.clientId }).lean();
      const { rawToken } = readClientIgCreds(client);
      if (!rawToken) {
        return res.status(422).json({
          success: false,
          error: 'Your Instagram account is not connected. Go to Settings → Integrations → Instagram to connect.'
        });
      }
    }

    auto.status = newStatus;
    auto.updatedAt = new Date();
    await auto.save();

    if (newStatus === 'active') {
      // Best-effort. Failure here used to return 503 — that was the bug. Now we
      // log + continue so the user sees a successful toggle and we still get
      // the webhook subscription on first real comment.
      ensureWebhookSubscription(auto.clientId).catch(err =>
        log.warn(`[Toggle] Webhook subscription background error: ${err.message}`)
      );
    }

    res.status(200).json({ success: true, automation: auto, status: newStatus });
  } catch (error) {
    // Critical: anything that escapes here used to crash the route and surface
    // as a 503 from Express. Now it's a 500 with a JSON error body that the
    // frontend can render in a toast.
    log.error('Toggle error:', error.message, error.stack);
    res.status(500).json({ success: false, error: 'Failed to toggle automation status. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/ig-automation/:id
// Soft delete via deletedAt tombstone. Also flips status to 'paused' so any
// in-flight webhook events that race the delete don't fire DMs.
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const updated = await IGAutomation.findOneAndUpdate(
      { _id: req.params.id, deletedAt: null },
      { $set: { deletedAt: new Date(), status: 'paused', updatedAt: new Date() } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ success: false, error: 'Automation not found' });

    res.status(200).json({ success: true, message: 'Automation deleted', automationId: updated._id });
  } catch (error) {
    log.error('Delete error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete automation' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ig-automation/webhook-status?clientId=X
//
// Returns a full health report so the IG Automation header can show a
// "Webhooks: ✓ Healthy / ⚠ Missing fields / ✗ Disconnected" badge and
// surface the exact remediation (e.g. "comments,mentions not enabled in
// Meta App Dashboard"). Also returns recent webhook event counters so the
// support team can prove receipt without tailing logs.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/webhook-status', async (req, res) => {
  try {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required' });

    const client = await Client.findOne({ clientId }).lean();
    if (!client) return res.status(404).json({ success: false, error: 'Client not found' });

    const { rawToken, fbPageId, igUserId } = readClientIgCreds(client);
    const hasCreds = !!(rawToken && (igUserId || fbPageId));

    const pickAppSubscription = (subsRes) => {
      const apps = subsRes?.data || [];
      const myAppId = process.env.FACEBOOK_APP_ID || process.env.META_APP_ID;
      const mine = myAppId
        ? apps.find(a => String(a?.id || a?.app_id || a?.name || '') === String(myAppId))
        : null;
      return (mine?.subscribed_fields) || apps.flatMap(a => a?.subscribed_fields || []) || [];
    };

    let igLive = [];
    let pageLive = [];
    let liveError = null;

    if (hasCreds) {
      try {
        const accessToken = decrypt(rawToken);
        if (!accessToken) throw new Error('token_decrypt_failed');
        if (igUserId) {
          try {
            const subsIg = await getInstagramUserSubscriptions(igUserId, accessToken, { clientId });
            igLive = pickAppSubscription(subsIg);
          } catch (e) {
            liveError = liveError || `Instagram Graph: ${e.message}`;
          }
        }
        if (fbPageId) {
          try {
            const subsPg = await getFacebookPageSubscriptions(fbPageId, accessToken, { clientId });
            pageLive = pickAppSubscription(subsPg);
          } catch (e) {
            liveError = liveError || `Facebook Page: ${e.message}`;
          }
        }
      } catch (err) {
        liveError = err.message;
      }
    }

    const missingIg = igUserId ? diffInstagramGraphFields(igLive) : REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS.slice();
    const missingPage = fbPageId ? diffFacebookPageFields(pageLive) : [];
    const missing = [
      ...missingIg.map(f => `instagram:${f}`),
      ...missingPage.map(f => `page:${f}`)
    ];
    const liveSubscribedFields = Array.from(new Set([...igLive, ...pageLive]));

    // Lightweight recent-activity counters (last 24h) so the user can verify
    // webhooks are actually flowing — pulled from the existing session ledger.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentEvents = await IGAutomationSession.countDocuments({
      clientId,
      createdAt: { $gte: since }
    }).catch(() => 0);

    let healthy = 'unknown';
    if (!hasCreds) healthy = 'disconnected';
    else if (liveError) healthy = 'error';
    else if (missing.length === 0) healthy = 'healthy';
    else healthy = 'misconfigured';

    res.status(200).json({
      success: true,
      health: healthy,
      hasCredentials: hasCreds,
      fbPageId: fbPageId || null,
      pageId: fbPageId || null,
      igUserId: igUserId || null,
      igUsername: client.igUsername || client.instagramUsername || null,
      requiredFields: {
        instagram: REQUIRED_INSTAGRAM_GRAPH_WEBHOOK_FIELDS,
        page: REQUIRED_FACEBOOK_PAGE_WEBHOOK_FIELDS
      },
      subscription: {
        instagram: { id: igUserId || null, subscribedFields: igLive, missingFields: missingIg },
        page: { id: fbPageId || null, subscribedFields: pageLive, missingFields: missingPage }
      },
      subscribedFields: liveSubscribedFields,
      missingFields: missing,
      lastCheckedAt: client.igWebhookLastCheckedAt || null,
      lastError: liveError || client.igWebhookLastError || null,
      recentEvents24h: recentEvents,
      callbackUrlHint: `${process.env.PUBLIC_API_BASE_URL || ''}/api/ig-automation/webhook`.replace(/^\//, ''),
      remediation: missing.length > 0 ? [
        'Comment webhooks are registered on graph.instagram.com/{ig-user-id}/subscribed_apps; DM webhooks also use graph.facebook.com/{page-id}/subscribed_apps. The backend now calls both — not a single mixed list.',
        'In App Review, request Advanced Access for instagram_manage_comments and instagram_manage_messages or Live users outside your app roles will not receive webhooks.',
        'Click "Re-subscribe webhooks" in the dashboard after deploy.',
        `Missing: ${missing.join(', ')}.`
      ] : []
    });
  } catch (error) {
    log.error('Webhook-status error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to read webhook status' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ig-automation/webhook-resubscribe
// Body: { clientId }
//
// Forces a fresh `POST /{page-id}/subscribed_apps` against Meta with the
// canonical field list. Use this after fixing App Dashboard config or when
// the user clicks "Re-subscribe" in the header health badge.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook-resubscribe', async (req, res) => {
  try {
    const { clientId } = req.body || {};
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required' });

    const result = await ensureWebhookSubscription(clientId, { force: true });
    res.status(200).json({ success: result.ok, ...result });
  } catch (error) {
    log.error('Webhook-resubscribe error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to re-subscribe webhooks' });
  }
});

// Exported for the startup auto-healer (services/igWebhookHealer.js) and any
// future maintenance scripts. The router stays the default export.
module.exports = router;
module.exports.ensureWebhookSubscription = ensureWebhookSubscription;
