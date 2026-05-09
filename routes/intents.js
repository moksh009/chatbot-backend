const express = require('express');
const router = express.Router();
const IntentApiController = require('../controllers/IntentApiController');
const { verifyDashboardToken } = require('../middleware/DashboardAuthMiddleware');

// HARDENING 2: Simple rate limiter for AI generation endpoint
const rateLimitMap = new Map();
function aiRateLimit(maxRequests = 5, windowMs = 60000) {
  return (req, res, next) => {
    const key = req.user?.clientId || req.ip;
    const now = Date.now();
    const record = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
    
    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }
    
    record.count++;
    rateLimitMap.set(key, record);
    
    if (record.count > maxRequests) {
      return res.status(429).json({ 
        success: false, 
        message: 'Rate limit exceeded. Please wait before generating more training data.' 
      });
    }
    next();
  };
}

// Dashboard management routes
router.post('/', verifyDashboardToken, IntentApiController.upsertIntent);
router.get('/', verifyDashboardToken, IntentApiController.getIntents);
router.get('/pending-phrases', verifyDashboardToken, IntentApiController.getPendingPhrases);
router.get('/conversation-messages/:conversationId', verifyDashboardToken, IntentApiController.getTrainingConversationMessages);
router.get('/stats', verifyDashboardToken, IntentApiController.getIntentStats);
router.get('/analytics', verifyDashboardToken, IntentApiController.getIntentAnalytics);
router.get('/suggest-clusters', verifyDashboardToken, IntentApiController.suggestClusters);
router.post('/resolve-phrase', verifyDashboardToken, IntentApiController.resolvePhrase);
router.post('/resolve-bulk', verifyDashboardToken, IntentApiController.resolveBulk);
router.post('/simulate', verifyDashboardToken, IntentApiController.simulateIntent);
router.post('/generate-training', verifyDashboardToken, aiRateLimit(5, 60000), IntentApiController.generateTrainingData);
router.patch('/:intentId/toggle', verifyDashboardToken, IntentApiController.toggleIntent);
router.delete('/:intentId', verifyDashboardToken, IntentApiController.deleteIntent);

// --- Training Inbox / Unrecognized Phrases Routes ---

const UnrecognizedPhrase = require('../models/UnrecognizedPhrase');
const IntentRule = require('../models/IntentRule');

router.get('/unrecognized', verifyDashboardToken, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    if (!clientId) return res.status(400).json({ success: false, message: 'ClientId required' });
    
    const phrases = await UnrecognizedPhrase.find({ clientId, status: 'PENDING' })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
      
    res.json({ success: true, phrases });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/unrecognized/:id/assign', verifyDashboardToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { intentName } = req.body;
    const clientId = req.user.clientId;

    if (!intentName) return res.status(400).json({ success: false, message: 'Intent name required' });

    const phrase = await UnrecognizedPhrase.findOne({ _id: id, clientId });
    if (!phrase) return res.status(404).json({ success: false, message: 'Phrase not found' });

    const intent = await IntentRule.findOne({ clientId, intentName });
    if (!intent) return res.status(404).json({ success: false, message: 'Destination intent not found' });

    // Ensure the phrase isn't already there
    if (!intent.trainingPhrases) intent.trainingPhrases = [];
    if (!intent.trainingPhrases.includes(phrase.phrase)) {
      intent.trainingPhrases.push(phrase.phrase);
      await intent.save();
    }

    phrase.status = 'RESOLVED';
    phrase.assignedTo = intentName;
    await phrase.save();

    res.json({ success: true, message: 'Phrase assigned successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/unrecognized/:id', verifyDashboardToken, async (req, res) => {
  try {
    const { id } = req.params;
    const clientId = req.user.clientId;

    const phrase = await UnrecognizedPhrase.findOneAndDelete({ _id: id, clientId });
    if (!phrase) return res.status(404).json({ success: false, message: 'Phrase not found' });

    res.json({ success: true, message: 'Phrase deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
