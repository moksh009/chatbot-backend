// UNMOUNTED — no routes registered in index.js (Phase 3.1, June 2026 audit)
// Agent training cases UI removed; this file is an empty express.Router() stub.
// Internal training still flows via /api/intents/*, trainingOutcomeTracker, NlpEngineService.
// Delete this file only after confirming no external API consumers reference /api/training.
const express = require('express');

module.exports = express.Router();
