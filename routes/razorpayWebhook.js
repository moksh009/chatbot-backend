const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Subscription = require('../models/Subscription');
const Client = require('../models/Client');
const Invoice = require('../models/Invoice');

/**
 * POST /api/billing/webhook
 * Razorpay Webhook Handler
 */
router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return res.status(400).send('No signature or secret');
  }

  const body = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(400).send('Invalid signature');
  }

  const { event, payload } = req.body;
  console.log(`[RazorpayWebhook] Received event: ${event}`);

  try {
    switch (event) {
      case 'subscription.activated':
      case 'subscription.charged':
        await handleSubscriptionCharged(payload.subscription.entity, payload.payment?.entity);
        break;
      case 'subscription.cancelled':
        await handleSubscriptionStatusChange(payload.subscription.entity, 'cancelled');
        break;
      case 'subscription.halted':
        await handleSubscriptionStatusChange(payload.subscription.entity, 'frozen');
        break;
    }
  } catch (err) {
    console.error(`[RazorpayWebhook] Error processing ${event}:`, err.message);
  }

  res.json({ status: 'ok' });
});

async function handleSubscriptionCharged(subEntity, paymentEntity) {
  const razorpaySubId = subEntity.id;
  
  const sub = await Subscription.findOne({ razorpaySubId });
  if (!sub) return;

  sub.status = 'active';
  sub.currentPeriodStart = new Date(subEntity.current_start * 1000);
  sub.currentPeriodEnd = new Date(subEntity.current_end * 1000);
  
  // Reset usage for new period if it's a new charge
  const now = new Date();
  if (sub.currentPeriodStart > (sub.updatedAt || 0)) {
     sub.usageThisPeriod = { contacts: 0, messages: 0, campaigns: 0, aiCallsMade: 0 };
  }
  
  await sub.save();

  // Create Invoice record
  if (paymentEntity) {
    await Invoice.create({
      clientId: sub.clientId,
      subscriptionId: sub._id,
      razorpayPaymentId: paymentEntity.id,
      amount: paymentEntity.amount,
      status: 'paid',
      paidAt: new Date(paymentEntity.created_at * 1000),
      period: {
        start: sub.currentPeriodStart,
        end: sub.currentPeriodEnd
      }
    });
  }
  
  console.log(`[RazorpayWebhook] Subscription ${razorpaySubId} updated to active.`);
}

async function handleSubscriptionStatusChange(subEntity, newStatus) {
  const razorpaySubId = subEntity.id;
  await Subscription.findOneAndUpdate({ razorpaySubId }, { status: newStatus });
  console.log(`[RazorpayWebhook] Subscription ${razorpaySubId} status changed to ${newStatus}.`);
}

module.exports = router;
