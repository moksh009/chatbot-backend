"use strict";

const express = require('express');
const router = express.Router();

const crudController = require('../controllers/igAutomation/crudController');
const postPreviewController = require('../controllers/igAutomation/postPreviewController');
const mediaController = require('../controllers/igAutomation/mediaController');
const oEmbedController = require('../controllers/igAutomation/oEmbedController');

// Auth middleware
const { protect } = require('../middleware/auth');

// NOTE: Webhook routes (GET/POST /webhook) are mounted BEFORE express.json()
// in index.js for raw body isolation. They are NOT included here.

// Authenticated routes
router.use('/', protect, crudController);
router.post('/fetch-post-preview', protect, postPreviewController.fetchPostPreview);
router.use('/', protect, mediaController);
router.use('/', protect, oEmbedController);

module.exports = router;

