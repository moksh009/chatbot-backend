const express = require('express');
const router = express.Router();
const Subscription = require('../models/Subscription');
const { PLAN_LIMITS } = require('../utils/planLimits');
const { protect } = require('../middleware/auth');

/**
 * GET /api/billing/usage
 * Returns current subscription usage and tier limits
 */
router.get('/usage', protect, async (req, res) => {
  try {
    const sub = await Subscription.findOne({ clientId: req.user.clientId });
    if (!sub) {
      return res.status(404).json({ success: false, message: 'No subscription found' });
    }

    const planData = PLAN_LIMITS[sub.plan || 'trial'];

    res.json({
      success: true,
      subscription: sub,
      limits: planData
    });
  } catch (error) {
    console.error('Billing Usage Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

module.exports = router;
