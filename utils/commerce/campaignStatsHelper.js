'use strict';

const Message = require('../../models/Message');
const Campaign = require('../../models/Campaign');
const CampaignMessage = require('../../models/CampaignMessage');
const { normalizePhone } = require('../core/helpers');
const log = require('../core/logger')('CampaignStats');
const { BILLABLE_STATUSES } = require('./campaignOverviewMetrics');

const ATTRIBUTION_WINDOW_DAYS = 7;

function buildPhoneVariants(phone = '') {
  const normalized = normalizePhone(phone || '');
  if (!normalized) return [];
  const variants = new Set([normalized]);
  if (normalized.length === 12 && normalized.startsWith('91')) {
    variants.add(normalized.slice(2));
    variants.add(`+${normalized}`);
  }
  if (normalized.length === 10) {
    variants.add(`91${normalized}`);
    variants.add(`+91${normalized}`);
  }
  return [...variants];
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

    await Campaign.findByIdAndUpdate(recentMsg.campaignId, {
      $inc: {
        revenueAttributed: amount,
        attributedOrders: 1,
      },
    });

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
};
