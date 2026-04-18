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
router.get('/stats', verifyDashboardToken, IntentApiController.getIntentStats);
router.get('/analytics', verifyDashboardToken, IntentApiController.getIntentAnalytics);
router.get('/suggest-clusters', verifyDashboardToken, IntentApiController.suggestClusters);
router.post('/resolve-phrase', verifyDashboardToken, IntentApiController.resolvePhrase);
router.post('/resolve-bulk', verifyDashboardToken, IntentApiController.resolveBulk);
router.post('/simulate', verifyDashboardToken, IntentApiController.simulateIntent);
router.post('/generate-training', verifyDashboardToken, aiRateLimit(5, 60000), IntentApiController.generateTrainingData);
router.patch('/:intentId/toggle', verifyDashboardToken, IntentApiController.toggleIntent);
router.delete('/:intentId', verifyDashboardToken, IntentApiController.deleteIntent);

module.exports = router;
