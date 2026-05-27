'use strict';

const CartRecoveryAttempt = require('../../models/CartRecoveryAttempt');
const Client = require('../../models/Client');
const {
  normalizeIndianPhone,
  indianPhoneDigits,
} = require('../core/normalizeIndianPhone');
const log = require('../core/logger')('CartRecoveryAttempt');

const CART_FOLLOWUP_SLOTS = ['followup_1', 'followup_2', 'followup_3'];

function contactPhoneKey(raw) {
  const digits = indianPhoneDigits(raw);
  if (digits && digits.length >= 10) return digits;
  const fallback = String(raw || '').replace(/\D/g, '');
  return fallback.length >= 10 ? fallback.slice(-12) : '';
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

/**
 * After a successful WhatsApp cart recovery template send.
 */
async function recordWhatsappTemplateSent({ clientId, phone, templateName, followupNumber }) {
  const contactPhone = contactPhoneKey(phone);
  if (!contactPhone) return null;

  const now = new Date();
  const attempt = await CartRecoveryAttempt.findOne({
    clientId,
    contactPhone,
    status: 'pending',
    recoveredViaWhatsapp: { $ne: true },
    organicRecovery: { $ne: true },
  }).sort({ createdAt: -1 });

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
      },
    },
    $set: {
      messaged: true,
      recoveryStep: Number(followupNumber) || attempt.recoveryStep || 0,
      updatedAt: now,
    },
  };

  if (!attempt.whatsappMessageSentAt) {
    update.$set.whatsappMessageSentAt = now;
  }

  return CartRecoveryAttempt.findByIdAndUpdate(attempt._id, update, { new: true });
}

/**
 * Attribute a Shopify order to the latest pending cart attempt for this phone.
 */
async function attributeOrderToRecoveryAttempt(clientId, orderData, cleanPhone) {
  const phoneRaw =
    cleanPhone ||
    orderData?.customer?.phone ||
    orderData?.shipping_address?.phone ||
    orderData?.phone;
  const contactPhone = contactPhoneKey(phoneRaw);
  if (!contactPhone) return null;

  const attempt = await CartRecoveryAttempt.findOne({
    clientId,
    contactPhone,
    status: 'pending',
  }).sort({ createdAt: -1 });

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

  if (attempt.whatsappMessageSentAt) {
    patch.recoveredViaWhatsapp = true;
    patch.organicRecovery = false;
  } else {
    patch.organicRecovery = true;
    patch.recoveredViaWhatsapp = false;
  }

  return CartRecoveryAttempt.findByIdAndUpdate(attempt._id, { $set: patch }, { new: true });
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
      },
    },
  ]);

  return {
    recoveredCarts: result[0]?.count || 0,
    revenueRecovered: result[0]?.totalRevenue || 0,
    organicRecovered: result[0]?.organicCount || 0,
    waRecovered: result[0]?.waCount || 0,
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

function buildWhatsappFollowupDisplay(attempt, config = { followups: [] }) {
  if (!attempt) {
    return {
      lines: [{ text: 'Pending — no message sent yet', tone: 'muted' }],
      attempt: null,
    };
  }

  if (attempt.status === 'recovered') {
    if (attempt.recoveredViaWhatsapp) {
      return { lines: [{ text: 'Recovered via WhatsApp', tone: 'sent' }], attempt };
    }
    if (attempt.organicRecovery) {
      return { lines: [{ text: 'Organic recovery', tone: 'sent' }], attempt };
    }
    return { lines: [{ text: 'Recovered', tone: 'sent' }], attempt };
  }

  const sent = Array.isArray(attempt.whatsappTemplatesSent) ? attempt.whatsappTemplatesSent : [];
  const lines = [];

  if (!sent.length && !attempt.whatsappMessageSentAt) {
    return {
      lines: [{ text: 'Pending — no message sent yet', tone: 'muted' }],
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
      if (sentByNum.has(f.followupNumber)) {
        lines.push({ text: `${f.label} — Sent`, tone: 'sent' });
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

  return { lines, attempt };
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

  return { key: 'active', label: 'Active abandoned' };
}

module.exports = {
  contactPhoneKey,
  getCartFollowupConfig,
  recordWhatsappTemplateSent,
  attributeOrderToRecoveryAttempt,
  getWhatsappRecoveryMetrics,
  getRecoveryTotalsFromAttempts,
  loadLatestAttemptsByPhone,
  buildWhatsappFollowupDisplay,
  recoveryStatusFromAttempt,
};
