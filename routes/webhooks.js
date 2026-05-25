'use strict';

const express = require('express');
const router = express.Router();

// Resend inbound email webhooks (not merchant outbound subscription UI)
const { handleIncomingEmail } = require('../utils/core/emailIntegration');
router.post('/resend/inbound', handleIncomingEmail);

module.exports = router;
