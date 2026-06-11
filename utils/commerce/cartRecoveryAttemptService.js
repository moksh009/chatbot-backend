'use strict';

const CartRecoveryAttempt = require('../../models/CartRecoveryAttempt');
const Client = require('../../models/Client');
const {
  normalizeIndianPhone,
  indianPhoneDigits,
} = require('../core/normalizeIndianPhone');
const log = require('../core/logger')('CartRecoveryAttempt');

const CART_FOLLOWUP_SLOTS = ['followup_1', 'followup_2', 'followup_3'];

/** Industry standard: credit WA recovery only within this window after first message. */
const WA_RECOVERY_ATTRIBUTION_WINDOW_MS =
  Number(process.env.CART_RECOVERY_ATTRIBUTION_HOURS || 24) * 60 * 60 * 1000;

function contactPhoneKey(raw) {
  const digits = indianPhoneDigits(raw);
  if (digits && digits.length >= 10) return digits;
  const fallback = String(raw || '').replace(/\D/g, '');
  return fallback.length >= 10 ? fallback.slice(-12) : '';
}

function withinWaAttributionWindow(attempt, recoveredAt = new Date()) {
  if (!attempt?.whatsappMessageSentAt) return false;
  const sentAt = new Date(attempt.whatsappMessageSentAt).getTime();
  const recoveredMs = new Date(recoveredAt).getTime();
  return recoveredMs - sentAt <= WA_RECOVERY_ATTRIBUTION_WINDOW_MS && recoveredMs >= sentAt;
}

/**
 * Create or reuse a pending attempt for this checkout (dedup by checkoutToken or leadId).
 */
async function ensureCartRecoveryAttempt({
  clientId,
  leadId,
  contactPhone,
  checkoutToken = '',
  cartToken = '',
  attemptTimestamp,
}) {
  if (!clientId || !contactPhone) return null;

  const token = checkoutToken ? String(checkoutToken).trim() : '';
  const now = attemptTimestamp ? new Date(attemptTimestamp) : new Date();

  if (token) {
    const byToken = await CartRecoveryAttempt.findOne({
      clientId,
      checkoutToken: token,
      status: 'pending',
    }).lean();
    if (byToken) return byToken;
  }

  if (leadId) {
    const byLead = await CartRecoveryAttempt.findOne({
      clientId,
      leadId,
      status: 'pending',
    }).lean();
    if (byLead) {
      if (token && !byLead.checkoutToken) {
        await CartRecoveryAttempt.updateOne(
          { _id: byLead._id },
          { $set: { checkoutToken: token, cartToken: cartToken || byLead.cartToken, updatedAt: now } }
        );
      }
      return CartRecoveryAttempt.findById(byLead._id).lean();
    }
  }

  try {
    return await CartRecoveryAttempt.create({
      clientId,
      leadId: leadId || null,
      contactPhone,
      checkoutToken: token,
      cartToken: cartToken ? String(cartToken) : '',
      attemptTimestamp: now,
      messaged: false,
      recovered: false,
      status: 'pending',
    });
  } catch (craErr) {
    if (craErr.code === 11000) {
      return CartRecoveryAttempt.findOne({
        clientId,
        checkoutToken: token,
        status: 'pending',
      }).lean();
    }
    log.warn(`[CartRecovery] ensure attempt failed: ${craErr.message}`);
    return null;
  }
}

/**
 * Whether Order Messages has at least one active abandoned-cart follow-up with a template.
 */
async function getCartFollowupConfig(clientId) {
  const client = await Client.findOne({ clientId }).select('commerceAutomations').lean();
  if (!client) {
    return { configured: false, followups: [], setupPath: '/shopify-automation-center?section=abandoned-cart&filter=cart' };
  }

  const cartRules = (client.commerceAutomations || []).filter(
    (a) => a.meta?.category === 'abandoned_cart' && a.isActive && a.templateName
  );

  const followups = CART_FOLLOWUP_SLOTS.map((slot, idx) => {
    const rule = cartRules.find((r) => r.meta?.systemSlot === slot);
    if (!rule?.templateName) return null;
    return {
      followupNumber: idx + 1,
      label: `Followup ${idx + 1}`,
      templateName: rule.templateName,
      systemSlot: slot,
    };
  }).filter(Boolean);

  return {
    configured: followups.length > 0,
    followups,
    setupPath: '/shopify-automation-center?section=abandoned-cart&filter=cart',
  };
}

async function findPendingAttemptForSend({ clientId, phone, leadId, checkoutToken }) {
  const contactPhone = contactPhoneKey(phone);
  if (!contactPhone) return null;

  const token = checkoutToken ? String(checkoutToken).trim() : '';
  if (token) {
    const byToken = await CartRecoveryAttempt.findOne({
      clientId,
      checkoutToken: token,
      status: 'pending',
    }).sort({ createdAt: -1 });
    if (byToken) return byToken;
  }

  if (leadId) {
    const byLead = await CartRecoveryAttempt.findOne({
      clientId,
      leadId,
      status: 'pending',
    }).sort({ createdAt: -1 });
    if (byLead) return byLead;
  }

  return CartRecoveryAttempt.findOne({
    clientId,
    contactPhone,
    status: 'pending',
    recoveredViaWhatsapp: { $ne: true },
    organicRecovery: { $ne: true },
  }).sort({ createdAt: -1 });
}

/**
 * After a successful WhatsApp cart recovery template send.
 */
async function recordWhatsappTemplateSent({
  clientId,
  phone,
  templateName,
  followupNumber,
  leadId,
  checkoutToken,
  messageId,
}) {
  const contactPhone = contactPhoneKey(phone);
  if (!contactPhone) return null;

  const now = new Date();
  const attempt = await findPendingAttemptForSend({
    clientId,
    phone,
    leadId,
    checkoutToken,
  });

  if (!attempt) {
    log.debug(`[CartRecovery] No pending attempt for ${clientId}/${contactPhone}`);
    return null;
  }

  const update = {
    $push: {
      whatsappTemplatesSent: {
        templateName: String(templateName || ''),
        sentAt: now,
        followupNumber: Number(followupNumber) || 0,
        messageId: messageId ? String(messageId) : '',
      },
    },
    $set: {
      messaged: true,
      recoveryStep: Number(followupNumber) || attempt.recoveryStep || 0,
      updatedAt: now,
      lastSendFailure: { step: 0, reason: '', detail: '', at: null },
    },
  };

  if (!attempt.whatsappMessageSentAt) {
    update.$set.whatsappMessageSentAt = now;
  }

  return CartRecoveryAttempt.findByIdAndUpdate(attempt._id, update, { new: true });
}

/**
 * Record a failed cart recovery send on the pending attempt (merchant visibility).
 */
async function recordCartRecoverySendFailure({
  clientId,
  phone,
  leadId,
  checkoutToken,
  stepNum,
  reason,
  detail,
}) {
  const attempt = await findPendingAttemptForSend({
    clientId,
    phone,
    leadId,
    checkoutToken,
  });
  if (!attempt) return null;

  return CartRecoveryAttempt.findByIdAndUpdate(
    attempt._id,
    {
      $set: {
        lastSendFailure: {
          step: Number(stepNum) || 0,
          reason: String(reason || 'failed'),
          detail: String(detail || '').slice(0, 512),
          at: new Date(),
        },
        updatedAt: new Date(),
      },
    },
    { new: true }
  );
}

async function findPendingAttemptForOrder(clientId, orderData, contactPhone) {
  const checkoutToken = orderData?.checkout_token || orderData?.token || '';
  const cartToken = orderData?.cart_token || '';

  if (checkoutToken) {
    const byCheckout = await CartRecoveryAttempt.findOne({
      clientId,
      checkoutToken: String(checkoutToken),
      status: 'pending',
    }).sort({ createdAt: -1 });
    if (byCheckout) return byCheckout;
  }

  if (cartToken) {
    const byCart = await CartRecoveryAttempt.findOne({
      clientId,
      cartToken: String(cartToken),
      status: 'pending',
    }).sort({ createdAt: -1 });
    if (byCart) return byCart;
  }

  if (contactPhone) {
    return CartRecoveryAttempt.findOne({
      clientId,
      contactPhone,
      status: 'pending',
    }).sort({ createdAt: -1 });
  }

  return null;
}

/**
 * Attribute a Shopify order to a cart attempt (checkout_token → cart_token → phone).
 */
async function attributeOrderToRecoveryAttempt(clientId, orderData, cleanPhone) {
  const phoneRaw =
    cleanPhone ||
    orderData?.customer?.phone ||
    orderData?.shipping_address?.phone ||
    orderData?.phone;
  const contactPhone = contactPhoneKey(phoneRaw);

  const attempt = await findPendingAttemptForOrder(clientId, orderData, contactPhone);
  if (!attempt) return null;

  const orderTotal = parseFloat(orderData.total_price || orderData.totalPrice || 0) || 0;
  const orderId = String(orderData.id || orderData.name || '');
  const now = new Date();

  const patch = {
    status: 'recovered',
    recovered: true,
    recoveredAt: now,
    recoveredOrderId: orderId,
    recoveredOrderValue: orderTotal,
    recoveredOrderAmount: orderTotal,
    updatedAt: now,
  };

  if (withinWaAttributionWindow(attempt, now)) {
    patch.recoveredViaWhatsapp = true;
    patch.organicRecovery = false;
  } else {
    patch.organicRecovery = true;
    patch.recoveredViaWhatsapp = false;
  }

  return CartRecoveryAttempt.findByIdAndUpdate(attempt._id, { $set: patch }, { new: true });
}

/**
 * Update delivery/read status on cart recovery template sends (Meta status webhook).
 */
async function updateCartRecoveryMessageStatus({ clientId, messageId, status, timestamp }) {
  if (!clientId || !messageId || !status) return null;

  const attempt = await CartRecoveryAttempt.findOne({
    clientId,
    'whatsappTemplatesSent.messageId': String(messageId),
  });
  if (!attempt) return null;

  const ts = timestamp ? new Date(timestamp) : new Date();
  const sent = attempt.whatsappTemplatesSent || [];
  let idx = -1;
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    if (String(sent[i].messageId) === String(messageId)) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;

  const field =
    status === 'delivered' ? 'deliveredAt' : status === 'read' ? 'readAt' : null;
  if (!field) return null;

  const path = `whatsappTemplatesSent.${idx}.${field}`;
  return CartRecoveryAttempt.findByIdAndUpdate(
    attempt._id,
    { $set: { [path]: ts, updatedAt: ts } },
    { new: true }
  );
}

async function getWhatsappRecoveryMetrics(clientId, from, to) {
  const config = await getCartFollowupConfig(clientId);
  if (!config.configured) {
    return {
      configured: false,
      recoveredViaWhatsapp: null,
      waRevenueRecovered: null,
      setupPath: config.setupPath,
    };
  }

  const filter = {
    clientId,
    recoveredViaWhatsapp: true,
    status: 'recovered',
  };

  if (from || to) {
    filter.recoveredAt = {};
    if (from) filter.recoveredAt.$gte = from;
    if (to) filter.recoveredAt.$lte = to;
  }

  const result = await CartRecoveryAttempt.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        totalRevenue: {
          $sum: {
            $ifNull: ['$recoveredOrderValue', { $ifNull: ['$recoveredOrderAmount', 0] }],
          },
        },
      },
    },
  ]);

  return {
    configured: true,
    recoveredViaWhatsapp: result[0]?.count || 0,
    waRevenueRecovered: result[0]?.totalRevenue || 0,
    setupPath: config.setupPath,
  };
}

async function getRecoveryTotalsFromAttempts(clientId, from, to) {
  const filter = { clientId, status: 'recovered' };
  if (from || to) {
    filter.recoveredAt = {};
    if (from) filter.recoveredAt.$gte = from;
    if (to) filter.recoveredAt.$lte = to;
  }

  const result = await CartRecoveryAttempt.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        totalRevenue: {
          $sum: {
            $ifNull: ['$recoveredOrderValue', { $ifNull: ['$recoveredOrderAmount', 0] }],
          },
        },
        organicCount: { $sum: { $cond: ['$organicRecovery', 1, 0] } },
        waCount: { $sum: { $cond: ['$recoveredViaWhatsapp', 1, 0] } },
        organicRevenue: {
          $sum: {
            $cond: [
              '$organicRecovery',
              { $ifNull: ['$recoveredOrderValue', { $ifNull: ['$recoveredOrderAmount', 0] }] },
              0,
            ],
          },
        },
        waRevenue: {
          $sum: {
            $cond: [
              '$recoveredViaWhatsapp',
              { $ifNull: ['$recoveredOrderValue', { $ifNull: ['$recoveredOrderAmount', 0] }] },
              0,
            ],
          },
        },
      },
    },
  ]);

  return {
    recoveredCarts: result[0]?.count || 0,
    revenueRecovered: result[0]?.totalRevenue || 0,
    organicRecovered: result[0]?.organicCount || 0,
    waRecovered: result[0]?.waCount || 0,
    organicRevenue: result[0]?.organicRevenue || 0,
    waRevenue: result[0]?.waRevenue || 0,
  };
}

async function loadLatestAttemptsByPhone(clientId, phones = []) {
  const keys = [...new Set(phones.map(contactPhoneKey).filter((p) => p.length >= 10))];
  if (!keys.length) return new Map();

  const attempts = await CartRecoveryAttempt.find({
    clientId,
    contactPhone: { $in: keys },
  })
    .sort({ attemptTimestamp: -1 })
    .lean();

  const map = new Map();
  for (const a of attempts) {
    if (!map.has(a.contactPhone)) map.set(a.contactPhone, a);
  }
  return map;
}

async function recordCartRecoveryClick({
  clientId,
  phone,
  followupNumber,
  clickType = 'link',
  attemptId = null,
  messageId = null,
}) {
  if (!clientId) return null;
  const contactPhone = contactPhoneKey(phone);
  const now = new Date();

  let attempt = null;
  if (attemptId) {
    attempt = await CartRecoveryAttempt.findOne({ _id: attemptId, clientId });
  }
  if (!attempt && contactPhone) {
    attempt = await CartRecoveryAttempt.findOne({
      clientId,
      contactPhone,
    }).sort({ updatedAt: -1 });
  }
  if (!attempt) return null;

  const sent = Array.isArray(attempt.whatsappTemplatesSent) ? attempt.whatsappTemplatesSent : [];
  let idx = -1;
  if (followupNumber) {
    idx = sent.findIndex((t) => Number(t.followupNumber) === Number(followupNumber));
  }
  if (idx < 0 && messageId) {
    idx = sent.findIndex((t) => String(t.messageId) === String(messageId));
  }
  if (idx < 0) {
    for (let i = sent.length - 1; i >= 0; i -= 1) {
      if (!sent[i]?.clickedAt) {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) return null;

  const path = `whatsappTemplatesSent.${idx}`;
  return CartRecoveryAttempt.findByIdAndUpdate(
    attempt._id,
    {
      $set: {
        [`${path}.clickedAt`]: now,
        [`${path}.clickType`]: clickType === 'button' ? 'button' : 'link',
        updatedAt: now,
      },
    },
    { new: true }
  );
}

async function recordCartRecoveryLinkClickFromShortCode(shortCode) {
  const CheckoutLink = require('../../models/CheckoutLink');
  const doc = await CheckoutLink.findOne({ shortCode: String(shortCode) }).lean();
  if (!doc || doc.source !== 'cart_recovery') return null;

  await CheckoutLink.updateOne(
    { _id: doc._id },
    { $set: { clicked: true, clickedAt: new Date() } }
  );

  return recordCartRecoveryClick({
    clientId: doc.clientId,
    phone: doc.phone,
    followupNumber: doc.followupNumber,
    clickType: 'link',
    attemptId: doc.cartRecoveryAttemptId,
  });
}

function buildFollowupSteps(attempt, config = { followups: [] }, leadRecoveryStep = 0) {
  const sentByNum = new Map();
  for (const t of attempt?.whatsappTemplatesSent || []) {
    const n = Number(t.followupNumber);
    if (n) sentByNum.set(n, t);
  }

  const labels = [1, 2, 3].map((n) => {
    const fromConfig = (config.followups || []).find((f) => f.followupNumber === n);
    return fromConfig?.label || `Message ${n}`;
  });

  return [1, 2, 3].map((stepNum, idx) => {
    const tpl = sentByNum.get(stepNum);
    const failStep = Number(attempt?.lastSendFailure?.step || 0);
    let status = 'pending';
    if (tpl?.clickedAt) status = 'clicked';
    else if (tpl?.readAt) status = 'read';
    else if (tpl?.deliveredAt) status = 'delivered';
    else if (tpl || Number(leadRecoveryStep) >= stepNum) status = 'sent';
    else if (failStep === stepNum) status = 'failed';

    return {
      step: stepNum,
      label: labels[idx],
      status,
      sentAt: tpl?.sentAt || null,
      deliveredAt: tpl?.deliveredAt || null,
      readAt: tpl?.readAt || null,
      clickedAt: tpl?.clickedAt || null,
      clickType: tpl?.clickType || null,
    };
  });
}

function summarizeMessageEngagement(attempt) {
  const sent = Array.isArray(attempt?.whatsappTemplatesSent) ? attempt.whatsappTemplatesSent : [];
  let linkClicks = 0;
  let buttonClicks = 0;
  for (const row of sent) {
    if (!row?.clickedAt) continue;
    if (row.clickType === 'button') buttonClicks += 1;
    else linkClicks += 1;
  }
  return { linkClicks, buttonClicks, messagesSent: sent.length };
}

function buildWhatsappFollowupDisplay(attempt, config = { followups: [] }, leadRecoveryStep = 0) {
  const steps = buildFollowupSteps(attempt, config, leadRecoveryStep);

  if (!attempt) {
    return {
      lines: [{ text: 'Pending — no message sent yet', tone: 'muted' }],
      steps,
      attempt: null,
    };
  }

  if (attempt.lastSendFailure?.reason && attempt.lastSendFailure?.at) {
    const failLine = {
      text: `Send failed (step ${attempt.lastSendFailure.step || '?'}): ${attempt.lastSendFailure.reason}`,
      tone: 'error',
    };
    if (attempt.status === 'recovered') {
      return {
        lines: [
          failLine,
          attempt.recoveredViaWhatsapp
            ? { text: 'Recovered via WhatsApp', tone: 'sent' }
            : { text: 'Organic recovery', tone: 'sent' },
        ],
        steps,
        attempt,
      };
    }
  }

  if (attempt.status === 'recovered') {
    if (attempt.recoveredViaWhatsapp) {
      return { lines: [{ text: 'Recovered via WhatsApp', tone: 'sent' }], steps, attempt };
    }
    if (attempt.organicRecovery) {
      return { lines: [{ text: 'Organic recovery', tone: 'sent' }], steps, attempt };
    }
    return { lines: [{ text: 'Recovered', tone: 'sent' }], steps, attempt };
  }

  const sent = Array.isArray(attempt.whatsappTemplatesSent) ? attempt.whatsappTemplatesSent : [];
  const lines = [];

  if (!sent.length && !attempt.whatsappMessageSentAt) {
    if (attempt.lastSendFailure?.reason) {
      return {
        lines: [
          {
            text: `Send failed: ${attempt.lastSendFailure.reason}`,
            tone: 'error',
          },
        ],
        steps,
        attempt,
      };
    }
    return {
      lines: [{ text: 'Pending — no message sent yet', tone: 'muted' }],
      steps,
      attempt,
    };
  }

  const sentByNum = new Map();
  for (const t of sent) {
    const n = Number(t.followupNumber) || 0;
    if (n) sentByNum.set(n, t);
  }

  const configured = config.followups || [];
  if (configured.length) {
    for (const f of configured) {
      const tpl = sentByNum.get(f.followupNumber);
      if (tpl) {
        let status = 'Sent';
        if (tpl.readAt) status = 'Read';
        else if (tpl.deliveredAt) status = 'Delivered';
        lines.push({ text: `${f.label} — ${status}`, tone: 'sent' });
      }
    }
    const next = configured.find((f) => !sentByNum.has(f.followupNumber));
    if (next) {
      lines.push({ text: `${next.label} — Scheduled`, tone: 'pending' });
    } else if (sentByNum.size >= configured.length) {
      lines.push({ text: 'All follow-ups sent', tone: 'muted' });
    }
  } else {
    for (const t of sent) {
      const n = Number(t.followupNumber) || 0;
      lines.push({
        text: n ? `Followup ${n} — Sent` : 'Message sent',
        tone: 'sent',
      });
    }
    if (sent.length && !configured.length) {
      lines.push({ text: 'No more follow-ups', tone: 'muted' });
    }
  }

  return { lines, steps, attempt };
}

function recoveryStatusFromAttempt(attempt, lead) {
  if (attempt?.status === 'recovered') {
    if (attempt.recoveredViaWhatsapp) {
      return { key: 'whatsapp', label: 'Recovered via WhatsApp' };
    }
    if (attempt.organicRecovery) {
      return { key: 'organic', label: 'Organic recovery' };
    }
    return { key: 'organic', label: 'Recovered' };
  }

  if (
    lead?.cartStatus === 'recovered' ||
    lead?.cartStatus === 'purchased' ||
    lead?.isOrderPlaced
  ) {
    if (lead?.recoveredViaWhatsApp || attempt?.whatsappMessageSentAt) {
      return { key: 'whatsapp', label: 'Recovered via WhatsApp' };
    }
    return { key: 'organic', label: 'Recovered' };
  }

  if (attempt?.lastSendFailure?.reason) {
    return { key: 'send_failed', label: 'Send failed — retrying' };
  }

  return { key: 'active', label: 'Active abandoned' };
}

function buildRecoveryTimeline(lead, attempt) {
  const events = [];
  const fmt = (d) => (d ? new Date(d) : null);

  const abandonedAt = lead?.cartAbandonedAt || lead?.lastCartEventAt;
  if (abandonedAt) {
    events.push({ at: fmt(abandonedAt), label: 'Cart abandoned', kind: 'abandon' });
  }

  const sent = Array.isArray(attempt?.whatsappTemplatesSent) ? attempt.whatsappTemplatesSent : [];
  for (const t of sent.sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt))) {
    const n = Number(t.followupNumber) || 0;
    if (t.sentAt) {
      events.push({
        at: fmt(t.sentAt),
        label: n ? `Message ${n} sent` : 'Recovery message sent',
        kind: 'sent',
      });
    }
    if (t.deliveredAt) {
      events.push({
        at: fmt(t.deliveredAt),
        label: n ? `Message ${n} delivered` : 'Message delivered',
        kind: 'delivered',
      });
    }
    if (t.readAt) {
      events.push({
        at: fmt(t.readAt),
        label: n ? `Message ${n} read` : 'Message read',
        kind: 'read',
      });
    }
  }

  if (attempt?.recoveredAt) {
    const via = attempt.recoveredViaWhatsapp ? 'via WhatsApp' : 'organic';
    const val = attempt.recoveredOrderValue || attempt.recoveredOrderAmount;
    const amt = val ? ` — ₹${Math.round(Number(val))}` : '';
    events.push({
      at: fmt(attempt.recoveredAt),
      label: `Order placed (${via})${amt}`,
      kind: 'recovered',
    });
  }

  return events
    .filter((e) => e.at || e.kind === 'abandon')
    .sort((a, b) => {
      if (!a.at) return 1;
      if (!b.at) return -1;
      return new Date(a.at) - new Date(b.at);
    });
}

module.exports = {
  contactPhoneKey,
  WA_RECOVERY_ATTRIBUTION_WINDOW_MS,
  ensureCartRecoveryAttempt,
  getCartFollowupConfig,
  recordWhatsappTemplateSent,
  recordCartRecoverySendFailure,
  recordCartRecoveryClick,
  recordCartRecoveryLinkClickFromShortCode,
  attributeOrderToRecoveryAttempt,
  updateCartRecoveryMessageStatus,
  getWhatsappRecoveryMetrics,
  getRecoveryTotalsFromAttempts,
  loadLatestAttemptsByPhone,
  buildWhatsappFollowupDisplay,
  buildFollowupSteps,
  summarizeMessageEngagement,
  recoveryStatusFromAttempt,
  buildRecoveryTimeline,
  findPendingAttemptForSend,
};
