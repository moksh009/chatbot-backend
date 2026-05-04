const express = require('express');
const router = express.Router();
const Subscription = require('../models/Subscription');
const Client = require('../models/Client');
const { protect } = require('../middleware/auth');
const { ensureClientForUser } = require('../utils/ensureClientForUser');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const {
  PLAN_LIMITS,
  PLAN_CHECKOUT,
  normalizePlanSlug,
  resolveRequestedPlan,
  getCheckoutMeta,
  getRazorpayPlanIdFromEnv
} = require('../config/planCatalog');
const { effectivePlanKey } = require('../utils/planLimits');
const { hasPaidActiveSubscription, isTrialWindowActive } = require('../utils/accessFlags');

function getRazorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return null;
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

/**
 * GET /api/billing/plan-catalog
 * Public-ish catalog for pricing UI (auth required for consistency).
 */
router.get('/plan-catalog', protect, (_req, res) => {
  res.json({
    success: true,
    plans: PLAN_CHECKOUT,
    trialDays: 14
  });
});

/**
 * GET /api/billing/usage
 */
router.get('/usage', protect, async (req, res) => {
  try {
    await ensureClientForUser(req.user);
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    let sub = await Subscription.findOne({ clientId: client.clientId }).lean();

    if (!sub) {
      sub = {
        plan: 'trial',
        status: 'trial',
        usageThisPeriod: { messages: 0, contacts: 0, campaigns: 0, aiCallsMade: 0 },
        currentPeriodEnd: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      };
    }

    const ek = effectivePlanKey(sub, client);
    const planData = PLAN_LIMITS[ek] || PLAN_LIMITS.trial;

    res.json({
      success: true,
      subscription: sub,
      effectivePlan: ek,
      limits: planData,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

/**
 * POST /api/billing/subscribe
 * Razorpay subscription when plan_id env is set; otherwise one-time order checkout.
 */
router.post('/subscribe', protect, async (req, res) => {
  const { plan, cycle = 'monthly' } = req.body;
  const slug = resolveRequestedPlan(plan);

  if (!slug) {
    return res.status(400).json({ success: false, message: 'Invalid plan selection' });
  }

  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const meta = getCheckoutMeta(slug);
    const razorpayPlanId = getRazorpayPlanIdFromEnv(slug);

    const rz = getRazorpay();
    if (!rz) {
      return res.status(503).json({
        success: false,
        message: 'Billing provider is not configured (missing Razorpay keys).'
      });
    }

    if (razorpayPlanId) {
      const subscription = await rz.subscriptions.create({
        plan_id: razorpayPlanId,
        customer_notify: 1,
        total_count: cycle === 'annual' ? 1 : 12,
        notes: {
          clientId: client.clientId,
          plan: slug
        }
      });

      return res.json({
        success: true,
        mode: 'subscription',
        subscriptionId: subscription.id,
        key: process.env.RAZORPAY_KEY_ID,
        name: 'TopEdge AI',
        description: `${meta.publicName} — ${cycle === 'annual' ? 'Annual' : 'Monthly'}`,
        plan: slug,
        prefill: {
          name: client.name || client.businessName,
          email: client.email || req.user?.email
        }
      });
    }

    const order = await rz.orders.create({
      amount: meta.amountPaise,
      currency: 'INR',
      receipt: `plan_${client.clientId}_${Date.now()}`.slice(0, 40),
      notes: {
        clientId: client.clientId,
        plan: slug
      }
    });

    return res.json({
      success: true,
      mode: 'order',
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
      name: 'TopEdge AI',
      description: `${meta.publicName} (first payment)`,
      plan: slug,
      prefill: {
        name: client.name || client.businessName,
        email: client.email || req.user?.email
      }
    });
  } catch (error) {
    console.error('Razorpay checkout error:', error);
    res.status(500).json({
      success: false,
      message: error.error?.description || error.description || 'Failed to initiate checkout'
    });
  }
});

/**
 * POST /api/billing/verify
 * Supports subscription payments and one-time order payments.
 */
router.post('/verify', protect, async (req, res) => {
  const body = req.body;
  const secret = process.env.RAZORPAY_KEY_SECRET;

  try {
    const client = await Client.findOne({ clientId: req.user.clientId });
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    const slug = resolveRequestedPlan(body.plan);
    if (!slug) {
      return res.status(400).json({ success: false, message: 'Invalid plan' });
    }

    if (body.razorpay_order_id && body.razorpay_payment_id && body.razorpay_signature) {
      const text = `${body.razorpay_order_id}|${body.razorpay_payment_id}`;
      const expected = crypto.createHmac('sha256', secret).update(text).digest('hex');
      if (expected !== body.razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Invalid payment signature' });
      }

      const meta = getCheckoutMeta(slug);
      const sub = await Subscription.findOneAndUpdate(
        { clientId: client.clientId },
        {
          $set: {
            plan: slug,
            status: 'active',
            amount: meta.amountPaise,
            currency: 'INR',
            billingCycle: 'monthly',
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            usageThisPeriod: { contacts: 0, messages: 0, campaigns: 0, aiCallsMade: 0 }
          },
          $setOnInsert: {
            clientId: client.clientId
          }
        },
        { new: true, upsert: true }
      );

      return res.json({ success: true, message: 'Payment verified', subscription: sub });
    }

    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = body;
    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Missing payment fields' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    const meta = getCheckoutMeta(slug);
    const sub = await Subscription.findOneAndUpdate(
      { clientId: client.clientId },
      {
        $set: {
          plan: slug,
          status: 'active',
          razorpaySubId: razorpay_subscription_id,
          amount: meta.amountPaise,
          currency: 'INR',
          billingCycle: 'monthly',
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          usageThisPeriod: { contacts: 0, messages: 0, campaigns: 0, aiCallsMade: 0 }
        },
        $setOnInsert: {
          clientId: client.clientId
        }
      },
      { new: true, upsert: true }
    );

    res.json({ success: true, message: 'Subscription activated!', subscription: sub });
  } catch (error) {
    console.error('[billing/verify]', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
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
 * GET /api/billing/:clientId
 * Combined billing + usage (must stay after static segments like /plan-catalog).
 */
router.get('/:clientId', protect, async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findOne({ clientId });

    if (!client) {
      return res.status(404).json({ success: false, message: 'Client not found' });
    }

    let sub = await Subscription.findOne({ clientId: client.clientId }).lean();

    const trialActive = client.billing?.trialActive ?? client.trialActive ?? true;
    const paid = hasPaidActiveSubscription(sub);
    const trialLive = isTrialWindowActive(client);

    const status = paid ? 'active' : trialLive ? 'trial' : 'expired';

    const ek = effectivePlanKey(sub || { plan: 'trial', status: trialLive ? 'trial' : 'inactive' }, client);
    const planLimits = PLAN_LIMITS[ek] || PLAN_LIMITS.trial;
    const meta = ek === 'trial' ? null : getCheckoutMeta(normalizePlanSlug(ek));

    const u = sub?.usageThisPeriod || {};
    const pct = (used, lim) => {
      if (lim === -1 || !lim) return 0;
      return Math.min((used / lim) * 100, 100);
    };

    const usage = {
      contacts: {
        used: u.contacts || 0,
        limit: planLimits.contacts,
        percent: pct(u.contacts || 0, planLimits.contacts)
      },
      messages: {
        used: u.messages || 0,
        limit: planLimits.messages,
        percent: pct(u.messages || 0, planLimits.messages)
      },
      campaigns: {
        used: u.campaigns || 0,
        limit: planLimits.campaigns,
        percent: pct(u.campaigns || 0, planLimits.campaigns === -1 ? Infinity : planLimits.campaigns)
      }
    };

    const atLimit =
      (planLimits.contacts !== -1 && usage.contacts.used >= planLimits.contacts) ||
      (planLimits.messages !== -1 && usage.messages.used >= planLimits.messages) ||
      (planLimits.campaigns !== -1 && usage.campaigns.used >= planLimits.campaigns);

    res.json({
      success: true,
      plan: meta ? meta.publicName : trialLive ? '14-Day Free Trial' : 'No active plan',
      planSlug: ek,
      planLine: meta?.line || (trialLive ? 'trial' : 'none'),
      status,
      tier: client.tier || 'v1',
      daysLeft: client.trialEndsAt ? Math.ceil((new Date(client.trialEndsAt) - new Date()) / (1000 * 60 * 60 * 24)) : 0,
      usage,
      atLimit: !!atLimit,
      nextBillingAmount: meta ? Math.round(meta.amountPaise / 100) : 0,
      subscriptionId: sub?.razorpaySubId,
      limits: planLimits
    });
  } catch (error) {
    console.error('Billing Fetch Error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch billing data' });
  }
});

module.exports = router;
