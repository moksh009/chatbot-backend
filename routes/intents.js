const express = require('express');
const router = express.Router();
const IntentApiController = require('../controllers/IntentApiController');
const { verifyDashboardToken } = require('../middleware/IntentAuthMiddleware');

// Dashboard management routes
router.post('/', verifyDashboardToken, IntentApiController.upsertIntent);
router.get('/', verifyDashboardToken, IntentApiController.getIntents);
router.get('/pending-phrases', verifyDashboardToken, IntentApiController.getPendingPhrases);
router.get('/stats', verifyDashboardToken, IntentApiController.getIntentStats);
router.post('/resolve-phrase', verifyDashboardToken, IntentApiController.resolvePhrase);

module.exports = router;
