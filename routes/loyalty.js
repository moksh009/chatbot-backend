const express = require('express');
const { resolveClient } = require('../utils/queryHelpers');
const router = express.Router();
const { 
    getLoyaltyStats,
    getCustomerWallet,
    backfillOrderPoints,
    sendLoyaltyReminderTemplate,
    redeemLoyaltyPoints,
    adjustWalletBalance,
    generateAIRewardCode,
    getLoyaltyStatus,
    getReputationStats,
    sendReviewRequest
} = require('../controllers/loyaltyController');
const { protect } = require('../middleware/auth');

// Admin-authenticated routes (require JWT)
router.get('/stats', protect, getLoyaltyStats);
router.get('/wallet', protect, getCustomerWallet);
router.post('/backfill', protect, backfillOrderPoints);
router.post('/send-reminder', protect, sendLoyaltyReminderTemplate);

// Shared routes (used by both chat engine and admin panel)
router.get('/status', getLoyaltyStatus);
router.post('/redeem', protect, redeemLoyaltyPoints);

// Admin-Only Adjustment & Rewards
router.post('/adjust', protect, adjustWalletBalance); // Legacy
router.post('/generate-reward', protect, generateAIRewardCode);

// Client specific phase 7 requests
router.post('/:clientId/manual-assign', protect, adjustWalletBalance);
router.post('/:clientId/send-reminder', protect, sendLoyaltyReminderTemplate);

// Reputation & Review Stats
router.get('/reputation-stats', protect, getReputationStats);
router.post('/send-review-request', protect, sendReviewRequest);

module.exports = router;
