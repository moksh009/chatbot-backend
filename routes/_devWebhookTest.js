'use strict';

const express = require('express');
const router = express.Router();

/** Dev-only webhook echo — never mounted in production (see index.js). */
router.post('/echo', (req, res) => {
  res.json({ ok: true, body: req.body, note: 'dev_webhook_test_only' });
});

module.exports = router;
