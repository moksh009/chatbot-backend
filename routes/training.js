const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const TrainingCase = require('../models/TrainingCase');

/**
 * POST /api/training/:clientId/correct
 * Saves a correction from an agent to improve bot intelligence.
 */
router.post('/:clientId/correct', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { userMessage, botResponse, agentCorrection, conversationId, phone } = req.body;

    if (!userMessage || !botResponse || !agentCorrection) {
      return res.status(400).json({ success: false, message: 'Missing required training data' });
    }

    const trainingCase = new TrainingCase({
      clientId,
      userMessage,
      botResponse,
      agentCorrection,
      conversationId,
      phone
    });

    await trainingCase.save();

    res.json({ 
      success: true, 
      message: 'Correction saved successfully. The bot will learn from this during the next training cycle.' 
    });
  } catch (error) {
    console.error('[Training] Error saving correction:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
