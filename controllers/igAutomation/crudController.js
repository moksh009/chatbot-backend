"use strict";

const express = require('express');
const router = express.Router();
const IGAutomation = require('../../models/IGAutomation');
const IGAutomationSession = require('../../models/IGAutomationSession');
const Client = require('../../models/Client');
const { subscribePageToWebhooks } = require('../../utils/igGraphApi');
const { validateAutomationMessages } = require('../../utils/igTextValidation');
const { decrypt } = require('../../utils/encryption');
const log = require('../../utils/logger')('IGAutoCRUD');

/**
 * GET /api/ig-automation?clientId=X&type=comment_to_dm
 * Returns all automations for a client, sorted by createdAt descending.
 */
router.get('/', async (req, res) => {
  try {
    const { clientId, type } = req.query;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required' });

    const filter = { clientId, status: { $ne: 'archived' } };
    if (type) filter.type = type;

    const automations = await IGAutomation.find(filter).sort({ createdAt: -1 }).lean();

    // Never return sensitive credentials
    res.status(200).json({ success: true, automations });
  } catch (error) {
    log.error('Fetch error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch automations' });
  }
});

/**
 * GET /api/ig-automation/stats?clientId=X&type=comment_to_dm
 * Returns aggregated stats for the panel header.
 */
router.get('/stats', async (req, res) => {
  try {
    const { clientId, type } = req.query;
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId is required' });

    const filter = { clientId, status: { $ne: 'archived' } };
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

/**
 * GET /api/ig-automation/activity?clientId=X&limit=50
 * Returns recent automation activity for the Inbox panel.
 */
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

    // Mask IGSIDs for privacy (first 4 chars + ... + last 4 chars)
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

/**
 * POST /api/ig-automation
 * Creates a new automation. Validates all fields server-side.
 */
router.post('/', async (req, res) => {
  try {
    const payload = req.body;
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

    // If deploying as active, verify client has IG token
    if (status === 'active') {
      const client = await Client.findOne({ clientId }).lean();
      if (!client || (!client.instagramAccessToken && !client.social?.instagram?.accessToken)) {
        return res.status(422).json({
          success: false,
          error: 'Your Instagram account is not connected. Go to Settings → Integrations → Instagram to connect.'
        });
      }
    }

    // Validate flow has opening DM for active automations
    if (status === 'active' && !payload.flow?.openingDm) {
      return res.status(400).json({ success: false, error: 'Opening DM message is required for active automations' });
    }

    const validationErrors = validateAutomationMessages(payload);
    if (validationErrors.length > 0) {
      return res.status(422).json({ success: false, errors: validationErrors });
    }

    const automation = new IGAutomation({
      ...payload,
      status: status || 'draft',
      stats: { totalTriggered: 0, totalDmsSent: 0, totalCommentReplies: 0, totalFollowGatePassed: 0, totalFollowGateFailed: 0 }
    });

    await automation.save();

    // If activating, ensure webhook subscription
    if (status === 'active') {
      await ensureWebhookSubscription(clientId);
    }

    res.status(201).json({ success: true, automation });
  } catch (error) {
    log.error('Create error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create automation' });
  }
});

/**
 * PATCH /api/ig-automation/:id
 * Updates an existing automation.
 */
router.patch('/:id', async (req, res) => {
  try {
    const { name, status, trigger, flow, targeting, storyTrigger } = req.body;

    const updateData = { updatedAt: new Date() };
    if (name !== undefined) updateData.name = name;
    if (status !== undefined) updateData.status = status;
    if (trigger !== undefined) updateData.trigger = trigger;
    if (flow !== undefined) updateData.flow = flow;
    if (targeting !== undefined) {
      // Don't allow direct mediaId override — oEmbed controller handles that
      const { mediaId, ...safeTargeting } = targeting;
      updateData.targeting = safeTargeting;
    }
    if (storyTrigger !== undefined) updateData.storyTrigger = storyTrigger;

    // Run text limits validation if flow is updated
    if (flow !== undefined || trigger !== undefined) {
      const tempPayload = { flow: flow || {}, trigger: trigger || {} };
      const validationErrors = validateAutomationMessages(tempPayload);
      if (validationErrors.length > 0) {
        return res.status(422).json({ success: false, errors: validationErrors });
      }
    }

    if (status === 'active') {
      const auto = await IGAutomation.findById(req.params.id).lean();
      if (!auto) return res.status(404).json({ success: false, error: 'Automation not found' });

      const client = await Client.findOne({ clientId: auto.clientId }).lean();
      if (!client || (!client.instagramAccessToken && !client.social?.instagram?.accessToken)) {
        return res.status(422).json({
          success: false,
          error: 'Your Instagram account is not connected. Go to Settings → Integrations → Instagram to connect.'
        });
      }
    }

    const updated = await IGAutomation.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true }
    );

    if (!updated) return res.status(404).json({ success: false, error: 'Automation not found' });

    res.status(200).json({ success: true, automation: updated });
  } catch (error) {
    log.error('Update error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update automation' });
  }
});

/**
 * PATCH /api/ig-automation/:id/toggle
 * Toggles status between 'active' and 'paused'.
 */
router.patch('/:id/toggle', async (req, res) => {
  try {
    const auto = await IGAutomation.findById(req.params.id);
    if (!auto) return res.status(404).json({ success: false, error: 'Automation not found' });

    const newStatus = auto.status === 'active' ? 'paused' : 'active';

    // If toggling to active, validate token + webhook subscription
    if (newStatus === 'active') {
      const client = await Client.findOne({ clientId: auto.clientId }).lean();
      if (!client || (!client.instagramAccessToken && !client.social?.instagram?.accessToken)) {
        return res.status(422).json({
          success: false,
          error: 'Your Instagram account is not connected. Go to Settings → Integrations → Instagram to connect.'
        });
      }

      // Ensure webhook subscription
      const subscribed = await ensureWebhookSubscription(auto.clientId);
      if (!subscribed) {
        return res.status(503).json({
          success: false,
          error: 'Failed to register Instagram webhook subscription. Please try again.'
        });
      }
    }

    auto.status = newStatus;
    auto.updatedAt = new Date();
    await auto.save();

    res.status(200).json({ success: true, automation: auto, status: newStatus });
  } catch (error) {
    log.error('Toggle error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to toggle status' });
  }
});

/**
 * DELETE /api/ig-automation/:id
 * Soft deletes by setting status to 'archived'.
 */
router.delete('/:id', async (req, res) => {
  try {
    const updated = await IGAutomation.findByIdAndUpdate(
      req.params.id,
      { $set: { status: 'archived', updatedAt: new Date() } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ success: false, error: 'Automation not found' });

    res.status(200).json({ success: true, message: 'Automation archived successfully' });
  } catch (error) {
    log.error('Delete error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to archive automation' });
  }
});

/**
 * Ensures the client's Instagram page is subscribed to webhook events.
 * Only makes the API call once per client (checks igWebhookSubscribed flag).
 */
async function ensureWebhookSubscription(clientId) {
  try {
    const client = await Client.findOne({ clientId });
    if (!client) return false;

    // Already subscribed
    if (client.igWebhookSubscribed) return true;

    const pageId = client.instagramPageId || client.social?.instagram?.pageId;
    const rawToken = client.instagramAccessToken || client.social?.instagram?.accessToken;
    const accessToken = decrypt(rawToken);
    if (!pageId || !accessToken) return false;

    await subscribePageToWebhooks(pageId, accessToken, { clientId });

    // Mark as subscribed
    await Client.findOneAndUpdate({ clientId }, { $set: { igWebhookSubscribed: true } });
    log.info(`[Webhook] Successfully subscribed page ${pageId} for client ${clientId}`);
    return true;
  } catch (err) {
    log.error(`[Webhook] Failed to subscribe for client ${clientId}:`, err.message);
    return false;
  }
}

module.exports = router;
