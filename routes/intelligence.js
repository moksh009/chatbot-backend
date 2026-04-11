const express = require('express');
const { resolveClient } = require('../utils/queryHelpers');
const router = express.Router();
const { protect } = require('../middleware/auth');
const CustomerIntelligence = require('../models/CustomerIntelligence');
const { computeDNA, getPersonalizationContext } = require('../utils/customerIntelligence');
const Client = require('../models/Client');

/**
 * GET /api/intelligence/dna/:phone
 * Returns the full behavioral DNA for a lead.
 */
router.get('/dna/:phone', protect, async (req, res) => {
  try {
    const { phone } = req.params;
    const clientId = req.user.clientId;

    let dna = await CustomerIntelligence.findOne({ clientId, phone });
    if (!dna) {
      // Upsert skeletal DNA
      dna = new CustomerIntelligence({ 
        clientId, 
        phone,
        engagementScore: 10,
        aiSummary: 'New lead detected. Behavioral synthesis in progress...'
      });
      await dna.save();
    }

    const brief = await getPersonalizationContext(clientId, phone);

    res.json({ success: true, dna, brief });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/intelligence/dna/:phone/recompute
 * Force an immediate AI recomputation of the DNA profile.
 */
router.post('/dna/:phone/recompute', protect, async (req, res) => {
  try {
    const { phone } = req.params;
    const clientId = req.user.clientId;

    const client = await Client.findOne({ clientId });
    const apiKey = client?.geminiApiKey || process.env.GEMINI_API_KEY;

    const dna = await computeDNA(clientId, phone, apiKey);
    if (!dna) {
      return res.status(404).json({ success: false, message: 'Could not compute DNA' });
    }

    res.json({ success: true, dna });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/intelligence/footprint
 * Returns the bot efficiency metrics and drop-off analysis.
 */
router.get('/footprint', protect, async (req, res) => {
  try {
    const { getBotEfficiency } = require('../utils/footprintEngine');
    const footprint = await getBotEfficiency(req.user.clientId);
    
    if (!footprint) {
      return res.status(500).json({ success: false, message: 'Failed to analyze footprint' });
    }

    res.json({ success: true, footprint });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
