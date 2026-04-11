const express = require('express');
const router = express.Router();
const IntentApiController = require('../controllers/IntentApiController');
const { protect } = require('../middleware/auth');

// Dashboard management routes
router.post('/', protect, IntentApiController.upsertIntent);
router.get('/', protect, IntentApiController.getIntents);
router.get('/pending-phrases', protect, IntentApiController.getPendingPhrases);
router.get('/stats', protect, IntentApiController.getIntentStats);
router.post('/resolve-phrase', protect, IntentApiController.resolvePhrase);

module.exports = router;
