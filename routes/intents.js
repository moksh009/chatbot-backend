const express = require('express');
const router = express.Router();
const IntentApiController = require('../controllers/IntentApiController');
const { protect } = require('../middleware/auth');
const { requireIntelligenceV2 } = require('../middleware/requireIntelligenceV2');

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

// Dashboard intent engine routes (training inbox / quality analytics removed)
router.use(protect, requireIntelligenceV2());
router.post('/', IntentApiController.upsertIntent);
router.get('/', IntentApiController.getIntents);
router.get('/stats', IntentApiController.getIntentStats);
router.post('/simulate', IntentApiController.simulateIntent);
router.post('/generate-training', aiRateLimit(5, 60000), IntentApiController.generateTrainingData);
router.patch('/:intentId/toggle', IntentApiController.toggleIntent);
router.delete('/:intentId', IntentApiController.deleteIntent);

module.exports = router;
