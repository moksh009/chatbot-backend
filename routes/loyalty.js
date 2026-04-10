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
    getLoyaltyStatus
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
router.post('/adjust', protect, adjustWalletBalance);
router.post('/generate-reward', protect, generateAIRewardCode);

module.exports = router;
