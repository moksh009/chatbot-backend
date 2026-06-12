const express = require('express');
const router = express.Router();
const IntentApiController = require('../controllers/IntentApiController');
const { protect } = require('../middleware/auth');

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
router.post('/', protect, IntentApiController.upsertIntent);
router.get('/', protect, IntentApiController.getIntents);
router.get('/stats', protect, IntentApiController.getIntentStats);
router.post('/simulate', protect, IntentApiController.simulateIntent);
router.post('/generate-training', protect, aiRateLimit(5, 60000), IntentApiController.generateTrainingData);
router.patch('/:intentId/toggle', protect, IntentApiController.toggleIntent);
router.delete('/:intentId', protect, IntentApiController.deleteIntent);

module.exports = router;
