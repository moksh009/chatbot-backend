'use strict';

const Message = require('../../models/Message');
const Campaign = require('../../models/Campaign');
const CampaignMessage = require('../../models/CampaignMessage');
const CampaignRevenueAttribution = require('../../models/CampaignRevenueAttribution');
const log = require('../core/logger')('CampaignStats');
const { BILLABLE_STATUSES } = require('./campaignOverviewMetrics');
const { normalizePhoneDigits } = require('./marketingConsent');

const ATTRIBUTION_WINDOW_DAYS = 7;

function buildPhoneVariants(phone = '') {
  const raw = String(phone || '').trim();
  const normalized = normalizePhoneDigits(raw);
  if (!normalized) return [];
  const variants = new Set([normalized, raw]);
  const rawDigits = raw.replace(/\D/g, '');
  if (rawDigits) variants.add(rawDigits);

  if (normalized.length === 12 && normalized.startsWith('91')) {
    variants.add(normalized.slice(2));
    variants.add(`+${normalized}`);
    variants.add(`+91${normalized.slice(2)}`);
  }
  if (normalized.length === 10) {
    variants.add(`91${normalized}`);
    variants.add(`+91${normalized}`);
  }
  return [...variants].filter(Boolean);
}

/**
 * Updates campaign performance metrics based on WhatsApp status updates (delivered, read, failed).
 * Legacy Message-model path — BullMQ campaigns use CampaignMessage in masterWebhook.
 */
async function updateCampaignStats(parsedStatus, client) {
  const { messageId, status } = parsedStatus;

  try {
    const message = await Message.findOneAndUpdate(
      { messageId },
      { status },
      { new: true }
    );

    if (!message || !message.campaignId) return;

    const campaignId = message.campaignId;
    const updateField = {};

    if (status === 'delivered') {
      updateField['stats.delivered'] = 1;
      updateField.deliveredCount = 1;
    } else if (status === 'read') {
      updateField['stats.read'] = 1;
      updateField.readCount = 1;
    }

    if (Object.keys(updateField).length > 0) {
      await Campaign.findByIdAndUpdate(campaignId, { $inc: updateField });
      log.info(`Updated Campaign ${campaignId} stats: ${status} for msg ${messageId}`);
    }
  } catch (err) {
    log.error(`Error updating campaign stats for ${messageId}:`, err.message);
  }
}

/**
 * Attribute Shopify / tracking order revenue to the most recent campaign message
 * sent to the same phone within the attribution window.
 */
async function attributeRevenueToCampaign(order, lead) {
  try {
    const clientId = order?.clientId || lead?.clientId;
    if (!clientId) return null;

    const phoneRaw =
      order?.customerPhone ||
      order?.phone ||
      lead?.phoneNumber ||
      lead?.phone;
    const variants = buildPhoneVariants(phoneRaw);
    if (!variants.length) return null;

    const amount = Number(
      order?.totalPrice || order?.amount || order?.total_price || 0
    );
    if (!amount || amount <= 0) return null;

    const orderDate = new Date(order?.createdAt || order?.orderDate || Date.now());
    const windowStart = new Date(
      orderDate.getTime() - ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );

    const recentMsg = await CampaignMessage.findOne({
      clientId,
      phone: { $in: variants },
      status: { $in: BILLABLE_STATUSES },
      sentAt: { $gte: windowStart, $lte: orderDate },
    })
      .sort({ sentAt: -1 })
      .lean();

    if (!recentMsg?.campaignId) return null;

    const orderKeyRaw =
      order?.shopifyOrderId ||
      order?.orderId ||
      order?.id ||
      order?._id;
    const orderKey = String(orderKeyRaw || '').trim();
    if (!orderKey) return null;

    const existing = await CampaignRevenueAttribution.findOne({
      clientId,
      orderKey,
    }).lean();

    if (
      existing &&
      String(existing.campaignId) === String(recentMsg.campaignId) &&
      Number(existing.amount || 0) === amount
    ) {
      return recentMsg.campaignId;
    }

    const campaignChanged =
      !!existing && String(existing.campaignId) !== String(recentMsg.campaignId);

    if (campaignChanged) {
      await Campaign.findByIdAndUpdate(existing.campaignId, {
        $inc: {
          revenueAttributed: -Math.max(0, Number(existing.amount || 0)),
          attributedOrders: -1,
        },
      });
    }

    const orderDelta = !existing ? 1 : campaignChanged ? 1 : 0;
    const revenueDelta = !existing
      ? amount
      : campaignChanged
        ? amount
        : amount - Number(existing.amount || 0);

    await Campaign.findByIdAndUpdate(recentMsg.campaignId, {
      $inc: {
        revenueAttributed: revenueDelta,
        attributedOrders: orderDelta,
      },
    });

    await CampaignRevenueAttribution.findOneAndUpdate(
      { clientId, orderKey },
      {
        $set: {
          orderId: String(order?.orderId || order?.shopifyOrderId || orderKey),
          campaignId: recentMsg.campaignId,
          phone: variants[0] || '',
          amount,
          attributedAt: orderDate,
          lastMessageSentAt: recentMsg.sentAt || null,
          source: 'shopify_webhook',
        },
      },
      { upsert: true }
    );

    log.info(
      `Attributed ₹${amount} to Campaign ${recentMsg.campaignId} for order ${order?.orderId || order?.shopifyOrderId || 'unknown'}`
    );
    return recentMsg.campaignId;
  } catch (err) {
    log.error('Revenue Attribution Error:', err.message);
    return null;
  }
}

module.exports = {
  updateCampaignStats,
  attributeRevenueToCampaign,
  buildPhoneVariants,
  ATTRIBUTION_WINDOW_DAYS,
};
