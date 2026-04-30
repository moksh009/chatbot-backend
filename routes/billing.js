const express = require('express');
const router = express.Router();
const Subscription = require('../models/Subscription');
const Client = require('../models/Client');
const { PLAN_LIMITS } = require('../utils/planLimits');
const { protect } = require('../middleware/auth');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * GET /api/billing/usage
 */
router.get('/usage', protect, async (req, res) => {
  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    let sub = await Subscription.findOne({ clientId: client._id });
    
    if (!sub) {
      sub = {
        plan: 'trial',
        status: 'trial',
        usageThisPeriod: { messages: 0, contacts: 0, campaigns: 0, aiCallsMade: 0 },
        currentPeriodEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      };
    }

    const planData = PLAN_LIMITS[sub.plan || 'trial'] || PLAN_LIMITS['trial'];

    res.json({
      success: true,
      subscription: sub,
      limits: planData,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

/**
 * GET /api/billing/:clientId
 * Returns combined billing and usage data for the frontend Billing page
 */
router.get('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId });
    
    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    // Get Subscription status
    let sub = await Subscription.findOne({ clientId: client._id });
    
    // Master Plan from Client document
    const masterPlan = client.plan || 'CX Agent (V1)';
    const trialActive = client.billing?.trialActive ?? client.trialActive ?? true;
    const tier = client.tier || 'v1';

    // Calculate Usage based on Client's usage tracker
    const normalizedPlan = masterPlan.toLowerCase().trim();
    const planLimits = PLAN_LIMITS[normalizedPlan] || PLAN_LIMITS['starter'];
    
    const usage = {
      contacts: {
        used: client.usage?.leadsCreated || 0,
        limit: planLimits.contacts,
        percent: planLimits.contacts > 0 ? ((client.usage?.leadsCreated || 0) / planLimits.contacts) * 100 : 0
      },
      messages: {
        used: client.usage?.messagesSent || 0,
        limit: planLimits.messages,
        percent: planLimits.messages > 0 ? ((client.usage?.messagesSent || 0) / planLimits.messages) * 100 : 0
      },
      campaigns: {
        used: client.usage?.campaignsSent || 0,
        limit: planLimits.campaigns,
        percent: planLimits.campaigns > 0 ? ((client.usage?.campaignsSent || 0) / planLimits.campaigns) * 100 : 0
      }
    };

    res.json({
      success: true,
      plan: masterPlan,
      status: sub?.status || (trialActive ? 'trial' : 'inactive'),
      tier: tier,
      daysLeft: client.trialEndsAt ? Math.ceil((new Date(client.trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)) : 0,
      usage,
      nextBillingAmount: sub?.nextAmount || 0,
      subscriptionId: sub?.razorpaySubId
    });

  } catch (error) {
    console.error('Billing Fetch Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch billing data' });
  }
});

/**
 * GET /api/billing/:clientId/invoices
 */
router.get('/:clientId/invoices', protect, async (req, res) => {
    try {
        const { clientId } = req.params;
        const client = await Client.findOne({ clientId });
        if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

        const Invoice = require('../models/Invoice');
        const invoices = await Invoice.find({ clientId: client._id }).sort({ createdAt: -1 }).limit(10);
        
        res.json({
            success: true,
            invoices
        });
    } catch (error) {
        console.error('Invoice Fetch Error:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch invoices' });
    }
});

/**
 * POST /api/billing/subscribe
 * Creates a Razorpay Subscription
 */
router.post('/subscribe', protect, async (req, res) => {
  const { plan, cycle = 'monthly' } = req.body;

  if (!['starter', 'growth', 'enterprise'].includes(plan)) {
    return res.status(400).json({ success: false, message: 'Invalid plan' });
  }

  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Plan IDs from .env (User must set these in Razorpay Dashboard)
    const planIdMap = {
      starter: process.env.RAZORPAY_PLAN_ID_STARTER,
      growth: process.env.RAZORPAY_PLAN_ID_GROWTH,
      enterprise: process.env.RAZORPAY_PLAN_ID_ENTERPRISE
    };

    const plan_id = planIdMap[plan];
    if (!plan_id || plan_id.includes('PH_')) {
      return res.status(400).json({ 
        success: false, 
        message: `Razorpay Plan ID not configured for ${plan}. Please contact support.` 
      });
    }

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan_id,
      customer_notify: 1,
      total_count: 12, // 1 year of monthly billing
      notes: {
        clientId: client.clientId,
        plan: plan
      }
    });

    res.json({
      success: true,
      subscriptionId: subscription.id,
      key: process.env.RAZORPAY_KEY_ID,
      name: 'TopEdge AI',
      description: `${plan.toUpperCase()} Plan Subscription`,
      prefill: {
        name: client.name,
        email: client.email
      }
    });

  } catch (error) {
    console.error('Razorpay Sub Error:', error);
    res.status(500).json({ success: false, message: error.description || 'Failed to initiate subscription' });
  }
});

/**
 * POST /api/billing/verify
 * Verification for Subscription Handshake
 */
router.post('/verify', protect, async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, plan } = req.body;

  try {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(razorpay_payment_id + "|" + razorpay_subscription_id)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const client = await Client.findOne({ clientId: req.user.clientId });
    
    // Update Subscription locally (Webhook will also confirm this later)
    const sub = await Subscription.findOneAndUpdate(
      { clientId: client._id },
      {
        plan,
        status: 'active',
        razorpaySubId: razorpay_subscription_id,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, message: 'Subscription activated!', subscription: sub });

  } catch (error) {
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

module.exports = router;
