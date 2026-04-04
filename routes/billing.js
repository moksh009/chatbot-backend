const express = require('express');
const router = express.Router();
const Subscription = require('../models/Subscription');
const Client = require('../models/Client');
const { PLAN_LIMITS } = require('../utils/planLimits');
const { protect } = require('../middleware/auth');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret',
});

/**
 * GET /api/billing/usage
 * Returns current subscription usage and tier limits
 */
router.get('/usage', protect, async (req, res) => {
  try {
    // 1. Resolve string clientId to Client ObjectId
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    // 2. Find subscription by Client _id (ObjectId)
    let sub = await Subscription.findOne({ clientId: client._id });
    
    // If no subscription exists, provide a default "trial" response instead of 404
    if (!sub) {
      sub = {
        plan: 'trial',
        status: 'trial',
        billingCycle: 'monthly',
        usageThisPeriod: {
          messages: 0,
          contacts: 0,
          campaigns: 0,
          aiCallsMade: 0
        },
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days from now
      };
    }

    const planData = PLAN_LIMITS[sub.plan || 'trial'] || PLAN_LIMITS['trial'];

    res.json({
      success: true,
      subscription: sub,
      limits: planData,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder'
    });
  } catch (error) {
    console.error('Billing Usage Error:', error);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

/**
 * POST /api/billing/subscribe
 * Create a new Razorpay order/subscription
 */
router.post('/subscribe', protect, async (req, res) => {
  const { plan, cycle } = req.body;

  if (!['starter', 'growth', 'enterprise'].includes(plan)) {
    return res.status(400).json({ success: false, message: 'Invalid plan' });
  }

  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const amountMap = {
      starter: 99900,   // 999 INR
      growth: 299900,   // 2999 INR
      enterprise: 799900 // 7999 INR
    };

    const amount = amountMap[plan];

    // Create Razorpay Order
    const options = {
      amount,
      currency: 'INR',
      receipt: `receipt_sub_${client.clientId}_${Date.now()}`,
      notes: {
        plan,
        clientId: client.clientId,
        email: client.email
      }
    };

    const order = await razorpay.orders.create(options);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
      name: 'TopEdge AI Subscription',
      description: `Upgrade to ${plan.toUpperCase()} Plan`,
      prefill: {
        name: client.name,
        email: client.email
      }
    });

  } catch (error) {
    console.error('Subscribe Error:', error);
    res.status(500).json({ success: false, message: 'Failed to initiate payment', error: error.message });
  }
});

/**
 * POST /api/billing/verify
 * Verify payment and update subscription
 */
router.post('/verify', protect, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan } = req.body;

  try {
    const secret = process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret';
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const generated_signature = hmac.digest('hex');

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    const client = await Client.findOne({ clientId: req.user.clientId });
    
    // Update Subscription
    const sub = await Subscription.findOneAndUpdate(
      { clientId: client._id },
      {
        plan,
        status: 'active',
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // +30 days
        amount: { starter: 99900, growth: 299900, enterprise: 799900 }[plan]
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, message: 'Subscription active!', subscription: sub });

  } catch (error) {
    console.error('Verify Error:', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

module.exports = router;
