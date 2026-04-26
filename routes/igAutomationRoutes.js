"use strict";

const express = require('express');
const router = express.Router();

const crudController = require('../controllers/igAutomation/crudController');
const oEmbedController = require('../controllers/igAutomation/oEmbedController');
const webhookController = require('../controllers/igAutomation/webhookController');

// Auth middleware
const { protect } = require('../middleware/auth');

// Webhook routes — NO auth (Meta calls these directly)
router.use('/', webhookController);

// Authenticated routes
router.use('/', protect, crudController);
router.use('/', protect, oEmbedController);

module.exports = router;
