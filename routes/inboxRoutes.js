"use strict";

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { apiCache } = require('../middleware/apiCache');
const { inboxConversationScope } = require('../middleware/inboxConversationScope');
const inbox = require('../controllers/unifiedInbox/inboxController');

// All inbox routes require authentication (+ autoTenantScope via protect)
router.use(protect);

/**
 * GET /api/inbox/workspace
 * Live Chat bundle: merged conversations + filter menu + channel counts.
 * Gate: FEATURE_INBOX_WORKSPACE_BUNDLE=true (frontend: VITE_FEATURE_INBOX_WORKSPACE_BUNDLE)
 */
router.get('/workspace', apiCache(30), async (req, res) => {
  if (process.env.FEATURE_INBOX_WORKSPACE_BUNDLE !== 'true') {
    return res.status(404).json({ success: false, error: 'Inbox workspace bundle not enabled' });
  }
  try {
    const { tenantClientId } = require('../utils/core/queryHelpers');
    const clientId = tenantClientId(req);
    if (!clientId) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const { buildInboxWorkspace } = require('../utils/hub/inboxWorkspaceBundle');
    const daysRaw = req.query.days;
    const days = daysRaw ? parseInt(daysRaw, 10) : null;
    const payload = await buildInboxWorkspace(req.user, clientId, {
      search: req.query.search || '',
      inboxFilter: req.query.filter || req.query.inboxFilter || 'all',
      days: Number.isFinite(days) && days > 0 ? days : null,
      channelFilter: req.query.channel || req.query.channelFilter || 'all',
      isImported: req.query.isImported === 'true' || req.query.isImported === true,
      importBatchId: req.query.importBatchId || null,
      limit: parseInt(req.query.limit, 10) || 50,
    });

    return res.json({ success: true, clientId, ...payload });
  } catch (err) {
    console.error('[inbox/workspace]', err);
    return res.status(500).json({ success: false, error: err.message || 'Failed to load inbox workspace' });
  }
});

// Dynamic inbox filters
router.get('/filters', apiCache(60), inbox.getFilters);

// Unified conversation list (merge-sort WhatsApp + Instagram)
router.get('/conversations', apiCache(30), inbox.listConversations);

// :id routes — tenant-scoped per channel (WhatsApp Conversation / IGConversation)
router.get('/conversations/:id/messages', inboxConversationScope(), inbox.getMessages);
router.patch('/conversations/:id/read', inboxConversationScope(), inbox.markRead);
router.post('/conversations/:id/send', inboxConversationScope(), inbox.sendMessage);

module.exports = router;
