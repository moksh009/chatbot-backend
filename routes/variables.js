"use strict";

const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const { VARIABLE_REGISTRY } = require("../utils/variableRegistry");

/**
 * GET /api/variables/registry
 * Public to authenticated users — full variable catalogue for Flow Builder / docs.
 */
router.get("/registry", protect, async (req, res) => {
  try {
    res.json({ success: true, variables: VARIABLE_REGISTRY });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
