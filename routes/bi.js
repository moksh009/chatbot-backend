const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const Client = require('../models/Client');
const { processBIQuery, generateQuerySuggestions } = require('../utils/biEngine');

/**
 * GET /api/bi/suggestions
 * @desc Get AI-suggested questions based on business context
 * @access Private
 */
router.get('/suggestions', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const client = await Client.findOne({ clientId });
    const apiKey = client?.openaiApiKey?.trim() || client?.geminiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();

    const suggestions = await generateQuerySuggestions(clientId, apiKey);
    res.json({ success: true, suggestions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/bi/ask
 * @desc Ask a natural language question about business data
 * @access Private
 */
router.post('/ask', protect, async (req, res) => {
  try {
    const { query } = req.body;
    const clientId = req.user.clientId;

    if (!query || query.trim().length < 3) {
      return res.status(400).json({ success: false, message: "Please provide a valid question." });
    }

    const client = await Client.findOne({ clientId });
    if (!client) {
      return res.status(404).json({ success: false, message: "Client configuration not found." });
    }

    // Use client's Gemini API key if available, else fallback
    const apiKey = client.openaiApiKey?.trim() || client.geminiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim();

    if (!apiKey) {
      return res.status(400).json({ 
        success: false, 
        message: "Gemini API key is not configured. Please add it in Settings -> AI Engine." 
      });
    }

    const result = await processBIQuery(clientId, query, apiKey);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    console.error('[BI Route] Error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: error.message || "An error occurred while processing your request." 
    });
  }
});

module.exports = router;
