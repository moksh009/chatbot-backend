'use strict';

const FollowUpSequence = require('../../models/FollowUpSequence');
const JourneyRevenueAttribution = require('../../models/JourneyRevenueAttribution');
const log = require('../core/logger')('JourneyAttribution');
const { buildPhoneVariants } = require('./campaignStatsHelper');

const ATTRIBUTION_WINDOW_HOURS = 168;

/**
 * Backfill FollowUpSequence step delivery/read timestamps from Meta status webhooks.
 */
async function updateJourneyStepStatus({ clientId, messageId, status, timestamp }) {
  if (!messageId || !status) return false;
  const ts = timestamp instanceof Date ? timestamp : new Date();
  const mid = String(messageId).trim();
  if (!mid) return false;

  const filter = { 'steps.messageId': mid };
  if (clientId) filter.clientId = clientId;

  const seq = await FollowUpSequence.findOne(filter).lean();
  if (!seq?.steps?.length) return false;

  const stepIdx = seq.steps.findIndex((s) => String(s?.messageId || '') === mid);
  if (stepIdx < 0) return false;

  const path = `steps.${stepIdx}`;
  const $set = {};
  if (status === 'delivered') {
    $set[`${path}.deliveredAt`] = ts;
  } else if (status === 'read') {
    $set[`${path}.readAt`] = ts;
    if (!seq.steps[stepIdx]?.deliveredAt) {
      $set[`${path}.deliveredAt`] = ts;
    }
  } else {
    return false;
  }

  await FollowUpSequence.updateOne({ _id: seq._id }, { $set });
  return true;
}

/**
 * Record WhatsApp template button / link tap on a journey step (context.messageId).
 */
async function updateJourneyStepClick({ clientId, messageId, timestamp, clickType = 'button' }) {
  const mid = String(messageId || '').trim();
  if (!mid) return false;
  const ts = timestamp instanceof Date ? timestamp : new Date();

  const filter = { 'steps.messageId': mid };
  if (clientId) filter.clientId = clientId;

  const seq = await FollowUpSequence.findOne(filter).lean();
  if (!seq?.steps?.length) return false;

  const stepIdx = seq.steps.findIndex((s) => String(s?.messageId || '') === mid);
  if (stepIdx < 0) return false;

  const path = `steps.${stepIdx}`;
  const $set = {
    [`${path}.clickedAt`]: ts,
    [`${path}.clickType`]: String(clickType || 'button'),
  };
  if (!seq.steps[stepIdx]?.deliveredAt) {
    $set[`${path}.deliveredAt`] = ts;
  }

  await FollowUpSequence.updateOne({ _id: seq._id }, { $set });
  return true;
}

/**
 * Backfill journey email step open/click from MessageEnvelope tracking webhooks.
 */
async function updateJourneyStepFromEnvelope({ clientId, envelopeId, type, timestamp }) {
  const envId = envelopeId;
  if (!envId || !type) return false;
  const ts = timestamp instanceof Date ? timestamp : new Date();

  const filter = { 'steps.envelopeId': envId };
  if (clientId) filter.clientId = clientId;

  const seq = await FollowUpSequence.findOne(filter).lean();
  if (!seq?.steps?.length) return false;

  const stepIdx = seq.steps.findIndex(
    (s) => s?.envelopeId && String(s.envelopeId) === String(envId)
  );
  if (stepIdx < 0) return false;

  const path = `steps.${stepIdx}`;
  const $set = {};
  if (type === 'open') {
    $set[`${path}.readAt`] = ts;
    if (!seq.steps[stepIdx]?.deliveredAt) {
      $set[`${path}.deliveredAt`] = ts;
    }
  } else if (type === 'click') {
    $set[`${path}.clickedAt`] = ts;
    $set[`${path}.clickType`] = 'link';
    if (!seq.steps[stepIdx]?.readAt) {
      $set[`${path}.readAt`] = ts;
    }
    if (!seq.steps[stepIdx]?.deliveredAt) {
      $set[`${path}.deliveredAt`] = ts;
    }
  } else {
    return false;
  }

  await FollowUpSequence.updateOne({ _id: seq._id }, { $set });
  return true;
}

/**
 * Find the best journey enrollment for last-touch attribution within the window.
 */
function latestJourneyTouch(sequences, orderDate, windowStart) {
  let best = null;
  for (const seq of sequences) {
    if (!seq.sourceFlowId) continue;
    const steps = seq.steps || [];
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (step.status !== 'sent' || !step.sentAt) continue;
      const sentAt = new Date(step.sentAt);
      if (sentAt < windowStart || sentAt > orderDate) continue;
      if (!best || sentAt > best.sentAt) {
        best = {
          sequenceId: seq._id,
          sourceFlowId: seq.sourceFlowId,
          leadId: seq.leadId,
          stepIndex: i,
          sentAt,
          channel: step.channel || 'whatsapp',
          playbookKey: seq.playbookKey || '',
        };
      }
    }
  }
  return best;
}

/**
 * Attribute Shopify order revenue to the most recent journey message (last-touch, 7d).
 */
async function attributeRevenueToJourney(order, lead) {
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
      orderDate.getTime() - ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000
    );

    const phoneOr = variants.flatMap((v) => [{ phone: v }, { phone: `+${v}` }]);
    const sequences = await FollowUpSequence.find({
      clientId,
      sourceFlowId: { $ne: '' },
      $or: phoneOr,
    })
      .select('sourceFlowId leadId playbookKey steps phone')
      .lean();

    const touch = latestJourneyTouch(sequences, orderDate, windowStart);
    if (!touch?.sourceFlowId) return null;

    const orderKeyRaw =
      order?.shopifyOrderId ||
      order?.orderId ||
      order?.id ||
      order?._id;
    const orderKey = String(orderKeyRaw || '').trim();
    if (!orderKey) return null;

    const existing = await JourneyRevenueAttribution.findOne({
      clientId,
      orderKey,
    }).lean();

    if (
      existing &&
      String(existing.sourceFlowId) === String(touch.sourceFlowId) &&
      Number(existing.amount || 0) === amount
    ) {
      return touch.sourceFlowId;
    }

    const journeyType =
      touch.playbookKey ||
      (touch.sourceFlowId.includes('cart') ? 'cart_abandoned' : 'order_placed');

    await JourneyRevenueAttribution.findOneAndUpdate(
      { clientId, orderKey },
      {
        $set: {
          shopifyOrderId: String(order?.shopifyOrderId || order?.orderId || orderKey),
          sourceFlowId: touch.sourceFlowId,
          sequenceId: touch.sequenceId,
          leadId: touch.leadId,
          phone: variants[0] || '',
          amount,
          currency: order?.currency || 'INR',
          attributedAt: orderDate,
          lastMessageSentAt: touch.sentAt,
          attributionWindowHours: ATTRIBUTION_WINDOW_HOURS,
          channel: touch.channel,
          journeyType,
          source: 'shopify_webhook',
        },
      },
      { upsert: true }
    );

    log.info(
      `Attributed ₹${amount} to journey ${touch.sourceFlowId} for order ${orderKey}`
    );
    return touch.sourceFlowId;
  } catch (err) {
    log.error(`Journey revenue attribution error: ${err.message}`);
    return null;
  }
}

module.exports = {
  updateJourneyStepStatus,
  updateJourneyStepClick,
  updateJourneyStepFromEnvelope,
  attributeRevenueToJourney,
  latestJourneyTouch,
  ATTRIBUTION_WINDOW_HOURS,
};
