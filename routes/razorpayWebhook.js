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
const { replayGuard } = require('../middleware/webhookReplayGuard');
const razorpayReplay = replayGuard({
  header: 'x-razorpay-event-id',
  keyPrefix: 'razorpay_replay',
  ttlSec: 3600,
});

router.post('/webhook', razorpayReplay, async (req, res) => {
  if (req.webhookReplayDuplicate) return res.status(200).json({ ok: true, duplicate: true });
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!signature || !secret) {
    return res.status(401).end();
  }

  const body = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  if (signature !== expectedSignature) {
    const { auditLog } = require('../services/audit/auditWriter');
    auditLog({
      category: 'security',
      action: 'webhook_signature_failed',
      severity: 'high',
      clientId: 'system',
      actor: { type: 'system', source: 'razorpay_webhook', ip: req.ip },
      details: { event: req.body?.event },
    });
    return res.status(401).end();
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

  await Client.updateOne(
    { clientId: sub.clientId },
    {
      $set: {
        plan: sub.plan,
        subscriptionPlan: sub.plan,
        isPaidAccount: true,
      },
    }
  );
  const io = global.io;
  if (io) {
    io.to(`client_${sub.clientId}`).emit('billing_status_changed', { status: 'active', plan: sub.plan });
    const { emitDual } = require('../utils/core/socketEmit');
    emitDual(io, `client_${sub.clientId}`, 'billing_status_changed', { status: 'active', plan: sub.plan });
  }

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
  const sub = await Subscription.findOneAndUpdate({ razorpaySubId }, { status: newStatus }, { new: true });
  if (sub?.clientId) {
    const graceUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await Client.updateOne(
      { clientId: sub.clientId },
      { $set: { billingGraceUntil: graceUntil } }
    );
    const io = global.io;
    if (io) {
      const { emitDual } = require('../utils/core/socketEmit');
      emitDual(io, `client_${sub.clientId}`, 'billing_status_changed', { status: newStatus, graceUntil });
    }
  }
  console.log(`[RazorpayWebhook] Subscription ${razorpaySubId} status changed to ${newStatus}.`);
}

module.exports = router;
