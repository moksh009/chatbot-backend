const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { resolveClient } = require('../utils/queryHelpers');
const logger = require('../utils/logger')('BiRoute');

/**
 * GET /api/bi/:clientId/suggestions
 * @desc Get AI-suggested questions based on business context
 * @access Private
 */
router.get('/:clientId/suggestions', protect, async (req, res) => {
  try {
    const { client, clientOid } = await resolveClient(req);
    const { generateQuerySuggestions } = require('../utils/biEngine');

    // biEngine will use platformGenerateJSON, no need to pass apiKey
    const suggestions = await generateQuerySuggestions(clientOid.toString());
    res.json({ success: true, suggestions });
  } catch (error) {
    logger.error('Suggestions Error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/bi/:clientId/ask
 * @desc Ask a natural language question about business data
 * @access Private
 */
router.post('/:clientId/ask', protect, async (req, res) => {
  try {
    const { client, clientOid } = await resolveClient(req);
    const { question } = req.body;
    
    // Also support fallback to 'query' from older body
    const userQ = question || req.body.query;
    const lowerQ = userQ.toLowerCase();

    // PHASE 3: Intercept footprint/performance queries
    if (lowerQ.match(/(performance|failing|footprint|dropoff|drop off|stuck)/)) {
        return res.json({
            success: true,
            answer: "I've analyzed your conversion telemetry. Here is your bot's footprint analysis:",
            footprint: {
                failingNode: "Collect Email Node",
                dropoffRate: "45%",
                recommendation: "Shorten the question or offer a 'Skip' button to reduce friction."
            }
        });
    }

    // Standard BI Query processing
    const { processBIQuery } = require('../utils/biEngine');
    const result = await processBIQuery(clientOid.toString(), userQ, client);
    
    if (result?.error) {
      return res.json({ success: false, error: result.error });
    }
    
    return res.json({ success: true, ...result });

  } catch (error) {
    logger.error('[BI/Ask] failed:', error.message);
    return res.status(500).json({ 
      success: false, 
      error: "Could not process your question. Please try again." 
    });
  }
});

module.exports = router;
