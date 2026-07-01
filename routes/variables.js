"use strict";

const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { assertTenantAccess } = require('../utils/core/queryHelpers');
const { VARIABLE_REGISTRY } = require('../utils/core/variableRegistry');
const Client = require('../models/Client');

/**
 * GET /api/variables/registry
 * Full variable catalogue + tenant custom variable definitions for Flow Builder.
 * Query: clientId (optional; defaults to user's client)
 */
router.get("/registry", protect, async (req, res) => {
  try {
    const requestedId = String(req.query.clientId || '').trim();
    const userClientId = String(req.user?.clientId || '').trim();
    let clientId = requestedId || userClientId;

    if (requestedId && requestedId !== userClientId) {
      const gate = assertTenantAccess(req, requestedId);
      if (!gate.ok) {
        return res.status(gate.status).json({ success: false, message: gate.message });
      }
    }

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
