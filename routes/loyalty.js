const express = require('express');
const router = express.Router();
const { redeemLoyaltyPoints, getLoyaltyStatus } = require('../controllers/loyaltyController');
const { protect } = require('../middleware/auth');

/**
 * Public/Customer Routes (can be accessed via chat session or portal)
 */
router.get('/status', getLoyaltyStatus);
router.post('/redeem', redeemLoyaltyPoints);

module.exports = router;
