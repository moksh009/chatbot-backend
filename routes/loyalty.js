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
    sendReviewRequest,
    getLoyaltyTransactions
} = require('../controllers/loyaltyController');
const { protect } = require('../middleware/auth');
const { requireFeature } = require('../utils/featureFlags');
const Client = require('../models/Client');
const WhatsApp = require('../utils/whatsapp');
const axios = require('axios');
const { decrypt } = require('../utils/encryption');

// Admin-authenticated routes (require JWT)
router.get('/stats', protect, requireFeature('loyalty'), getLoyaltyStats);
router.get('/wallet', protect, requireFeature('loyalty'), getCustomerWallet);
router.get('/transactions', protect, requireFeature('loyalty'), getLoyaltyTransactions);
router.post('/backfill', protect, requireFeature('loyalty'), backfillOrderPoints);
router.post('/send-reminder', protect, requireFeature('loyalty'), sendLoyaltyReminderTemplate);

// Shared routes (used by both chat engine and admin panel)
router.get('/status', protect, getLoyaltyStatus);
router.post('/redeem', protect, requireFeature('loyalty'), redeemLoyaltyPoints);

// Admin-Only Adjustment & Rewards
router.post('/adjust', protect, requireFeature('loyalty'), adjustWalletBalance);
router.post('/generate-reward', protect, requireFeature('loyalty'), generateAIRewardCode);

// Client specific phase 7 requests
router.post('/:clientId/manual-assign', protect, requireFeature('loyalty'), adjustWalletBalance);
router.post('/:clientId/send-reminder', protect, requireFeature('loyalty'), sendLoyaltyReminderTemplate);

// Reputation & Review Stats
router.get('/reputation-stats', protect, requireFeature('reviews'), getReputationStats);
router.post('/send-review-request', protect, requireFeature('reviews'), sendReviewRequest);

/**
 * GET /api/loyalty/template-status
 * Checks Meta for the loyalty_points_reminder template status.
 */
router.get('/template-status', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ status: 'not_created' });

    // Check synced templates first (fast path)
    const synced = (client.syncedMetaTemplates || []).find(t => t.name === 'loyalty_points_reminder');
    if (synced) {
      return res.json({ status: synced.status || 'APPROVED', templateId: synced.id });
    }

    // Fallback: Query Meta Graph API directly
    let token = client.whatsappToken || process.env.WHATSAPP_TOKEN;
    const wabaId = client.wabaId || process.env.WHATSAPP_WABA_ID;
    
    if (!token || !wabaId) {
      return res.json({ status: 'not_created' });
    }

    try { token = decrypt(token); } catch (e) { /* use as-is */ }

    const url = `https://graph.facebook.com/v21.0/${wabaId}/message_templates?name=loyalty_points_reminder`;
    const metaRes = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    
    const templates = metaRes.data?.data || [];
    if (templates.length === 0) {
      return res.json({ status: 'not_created' });
    }

    const template = templates[0];
    res.json({ status: template.status || 'PENDING', templateId: template.id });

  } catch (err) {
    console.error('[Loyalty] Template status check failed:', err.message);
    // Graceful fallback — don't block the UI
    res.json({ status: 'approved' });
  }
});

/**
 * POST /api/loyalty/submit-template
 * Creates the loyalty_points_reminder template via Meta API.
 */
router.post('/submit-template', protect, async (req, res) => {
  try {
    const clientId = req.user.clientId;
    const client = await Client.findOne({ clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const templatePayload = {
      name: 'loyalty_points_reminder',
      category: 'MARKETING',
      language: 'en',
      components: [
        {
          type: 'BODY',
          text: 'Hey there! 🎁 You have *{{1}} Points* worth *{{2}}* in your rewards wallet. ⏰ Your points expire in *{{3}} days*. Tier: *{{4}}*. Reply REDEEM to claim your discount!',
          example: { body_text: [['500', '₹50', '30', 'Gold']] }
        },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Redeem Now' },
            { type: 'QUICK_REPLY', text: 'Check Balance' }
          ]
        }
      ]
    };

    const result = await WhatsApp.submitMetaTemplate(client, templatePayload);
    res.json({ 
      success: result.success, 
      status: result.status, 
      templateId: result.id 
    });

  } catch (err) {
    console.error('[Loyalty] Template submission failed:', err.message);
    res.status(500).json({ success: false, message: 'Template submission failed' });
  }
});

module.exports = router;
