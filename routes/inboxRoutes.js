"use strict";

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { apiCache } = require('../middleware/apiCache');
const inbox = require('../controllers/unifiedInbox/inboxController');

// All inbox routes require authentication
router.use(protect);

// Dynamic inbox filters
router.get('/filters', apiCache(60), inbox.getFilters);

// Unified conversation list (merge-sort WhatsApp + Instagram)
router.get('/conversations', apiCache(30), inbox.listConversations);

// Channel-aware message fetch
router.get('/conversations/:id/messages', inbox.getMessages);

// Mark conversation as read (channel-aware)
router.patch('/conversations/:id/read', inbox.markRead);

// Send message (Instagram DM or delegate to WhatsApp)
router.post('/conversations/:id/send', inbox.sendMessage);

module.exports = router;
