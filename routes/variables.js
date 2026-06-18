"use strict";

const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { VARIABLE_REGISTRY } = require('../utils/core/variableRegistry');
const Client = require('../models/Client');

/**
 * GET /api/variables/registry
 * Full variable catalogue + tenant custom variable definitions for Flow Builder.
 * Query: clientId (optional; defaults to user's client)
 */
router.get("/registry", protect, async (req, res) => {
  try {
    const clientId = String(req.query.clientId || req.user?.clientId || '').trim();
    let customVariables = [];
    if (clientId) {
      const client = await Client.findOne({ clientId }).select('customVariables').lean();
      customVariables = Array.isArray(client?.customVariables) ? client.customVariables : [];
    }
    res.json({
      success: true,
      variables: VARIABLE_REGISTRY,
      customVariables,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
