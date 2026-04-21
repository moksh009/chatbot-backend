const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const ScoreTierConfig = require('../models/ScoreTierConfig');
const AdLead = require('../models/AdLead');
const { evaluateCustomerScore } = require('../services/ScoreEvaluationService');

const TaskQueueService = require('../services/TaskQueueService');

/**
 * GET /api/scoring/config/:clientId
 * Fetch the waterfall configuration for a client.
 */
router.get('/config/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    let config = await ScoreTierConfig.findOne({ clientId });
    
    if (!config) {
      // Return default config but don't save yet (until they edit/save)
      config = ScoreTierConfig.getDefaultConfig(clientId);
    }
    
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch config' });
  }
});

/**
 * POST /api/scoring/config/:clientId
 * Save the waterfall configuration and trigger re-scoring for all leads.
 */
router.post('/config/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { tiers } = req.body;

    const config = await ScoreTierConfig.findOneAndUpdate(
      { clientId },
      { tiers, isActive: true },
      { upsert: true, new: true }
    );

    // Enqueue background re-scoring task
    await TaskQueueService.addTask('RECOMPUTE_ALL_LEAD_SCORES', { clientId });

    res.json({ success: true, config, message: 'Configuration saved. Score re-computation started in background.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to save config' });
  }
});

module.exports = router;
