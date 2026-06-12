"use strict";

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { apiCache } = require('../middleware/apiCache');
const { inboxConversationScope } = require('../middleware/inboxConversationScope');
const inbox = require('../controllers/unifiedInbox/inboxController');

// All inbox routes require authentication (+ autoTenantScope via protect)
router.use(protect);

// Dynamic inbox filters
router.get('/filters', apiCache(60), inbox.getFilters);

// Unified conversation list (merge-sort WhatsApp + Instagram)
router.get('/conversations', apiCache(30), inbox.listConversations);

// :id routes — tenant-scoped per channel (WhatsApp Conversation / IGConversation)
router.get('/conversations/:id/messages', inboxConversationScope(), inbox.getMessages);
router.patch('/conversations/:id/read', inboxConversationScope(), inbox.markRead);
router.post('/conversations/:id/send', inboxConversationScope(), inbox.sendMessage);

module.exports = router;
