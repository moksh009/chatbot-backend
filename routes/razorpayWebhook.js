const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Subscription = require('../models/Subscription');
const Client = require('../models/Client');
const Invoice = require('../models/Invoice');
const User = require('../models/User');
const LifecycleAutomationLog = require('../models/LifecycleAutomationLog');
const { sendSystemEmail } = require('../utils/core/emailService');
const { renderBrandedEmail } = require('../services/mjmlEmailRenderer');
const { formatInr } = require('../config/planCatalog');
const { sendPlatformWhatsAppTemplate } = require('../services/lifecycle/platformWelcomeWhatsApp');

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
  await Client.updateOne(
    { clientId: sub.clientId, $or: [{ becamePayingAt: null }, { becamePayingAt: { $exists: false } }] },
    { $set: { becamePayingAt: new Date() } }
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

  await sendPaymentSuccessNotifications({
    sub,
    clientId: sub.clientId,
    paymentEntity,
  });
  
  console.log(`[RazorpayWebhook] Subscription ${razorpaySubId} updated to active.`);
}

async function sendPaymentSuccessNotifications({ sub, clientId, paymentEntity }) {
  if (String(process.env.SEND_PAYMENT_SUCCESS_NOTIFY || 'true').toLowerCase() === 'false') {
    return;
  }

  const dedupKey = `payment-success:${paymentEntity?.id || sub?.razorpaySubId || 'unknown'}`;
  const existing = await LifecycleAutomationLog.findOne({ sentForKey: dedupKey, status: 'sent' }).lean();
  if (existing) return;

  const client = await Client.findOne({ clientId }).lean();
  const adminUser = await User.findOne({ clientId, role: 'CLIENT_ADMIN' }).select('name email phone').lean();
  const recipientName = adminUser?.name || client?.name || 'there';
  const amountInr = paymentEntity?.amount ? Math.round(Number(paymentEntity.amount) / 100) : 0;
  const periodEnd = sub?.currentPeriodEnd
    ? new Date(sub.currentPeriodEnd).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : '';

  if (adminUser?.email) {
    const html = renderBrandedEmail({
      brandName: 'TopEdge AI',
      title: 'Payment received',
      bodyHtml: [
        `Hi ${recipientName}, thank you. We received your payment${amountInr ? ` of ${formatInr(amountInr)}` : ''}.`,
        `Plan: ${sub?.plan || 'TopEdge subscription'}.`,
        periodEnd ? `Your next renewal date is ${periodEnd}.` : '',
      ].filter(Boolean).join('\n\n'),
      ctaUrl: paymentEntity?.invoice_url || '',
      ctaLabel: paymentEntity?.invoice_url ? 'View invoice' : 'Open dashboard',
    });
    const ok = await sendSystemEmail({
      to: adminUser.email,
      subject: 'TopEdge payment received',
      html,
    });
    await LifecycleAutomationLog.create({
      clientId,
      clientName: client?.name || client?.businessName || '',
      automationType: 'payment_success',
      channel: 'email',
      status: ok ? 'sent' : 'failed',
      reason: ok ? '' : 'send_failed',
      sentForKey: dedupKey,
      metadata: { paymentId: paymentEntity?.id || null },
    }).catch(() => {});
  }

  if (adminUser?.phone) {
    const wa = await sendPlatformWhatsAppTemplate({
      toPhone: adminUser.phone,
      templateName: String(process.env.TOPEDGE_PAYMENT_SUCCESS_TEMPLATE_NAME || '').trim() || 'topedge_payment_success_v1',
      languageCode: 'en',
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: recipientName },
            { type: 'text', text: amountInr ? formatInr(amountInr) : 'your payment' },
            { type: 'text', text: periodEnd || 'your current billing period' },
          ],
        },
      ],
    });
    await LifecycleAutomationLog.create({
      clientId,
      clientName: client?.name || client?.businessName || '',
      automationType: 'payment_success',
      channel: 'whatsapp',
      status: wa.sent ? 'sent' : wa.skipped ? 'skipped' : 'failed',
      reason: wa.reason || '',
      sentForKey: dedupKey,
      metadata: { paymentId: paymentEntity?.id || null },
    }).catch(() => {});
  }
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
