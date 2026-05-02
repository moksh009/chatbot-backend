"use strict";

const express = require('express');
const router = express.Router();

const crudController = require('../controllers/igAutomation/crudController');
const postPreviewController = require('../controllers/igAutomation/postPreviewController');
const mediaController = require('../controllers/igAutomation/mediaController');

// Auth middleware
const { protect } = require('../middleware/auth');

// NOTE: Webhook routes (GET/POST /webhook) are mounted BEFORE express.json()
// in index.js for raw body isolation. They are NOT included here.

// Authenticated routes
//
// /fetch-post-preview is mounted BEFORE the catch-all crud router so the
// crud router's `/:id` PATCH/DELETE handlers do not accidentally claim
// the literal path segment.
//
// The /media route (PostGridPicker source) and /oembed route are NOT mounted.
// The post-grid fetch was the wrong approach (wizard now pastes URLs only)
// and /oembed has been folded into the canonical /fetch-post-preview flow,
// which uses the correct App-Token-vs-Page-Token split internally.
//
// mediaController now only owns /connection-status (the post-grid /media
// endpoint has been removed — see mediaController.js header comment).
router.post('/fetch-post-preview', protect, postPreviewController.fetchPostPreview);
router.use('/', protect, mediaController);
router.use('/', protect, crudController);

module.exports = router;

