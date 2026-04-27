"use strict";

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const inbox = require('../controllers/unifiedInbox/inboxController');

// All inbox routes require authentication
router.use(protect);

// Unified conversation list (merge-sort WhatsApp + Instagram)
router.get('/conversations', inbox.listConversations);

// Channel-aware message fetch
router.get('/conversations/:id/messages', inbox.getMessages);

// Mark conversation as read (channel-aware)
router.patch('/conversations/:id/read', inbox.markRead);

// Send message (Instagram DM or delegate to WhatsApp)
router.post('/conversations/:id/send', inbox.sendMessage);

module.exports = router;
