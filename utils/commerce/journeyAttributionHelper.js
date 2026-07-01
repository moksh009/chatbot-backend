'use strict';

const FollowUpSequence = require('../../models/FollowUpSequence');
const JourneyRevenueAttribution = require('../../models/JourneyRevenueAttribution');
const log = require('../core/logger')('JourneyAttribution');
const { buildPhoneVariants } = require('./campaignStatsHelper');

/** 30-day attribution window for cart / marketing / manual journeys */
const ATTRIBUTION_WINDOW_HOURS = 720;

/**
 * Transactional trigger types — these confirm an organic order and must never
 * receive revenue credit. Any playbookKey or sourceFlowId that contains one of
 * these strings is treated as non-attributable.
 */
const NON_REVENUE_PATTERNS = [
  'order_placed',
  'order-placed',
  'order_shipped',
  'order-shipped',
  'order_delivered',
  'order-delivered',
  'order_cancelled',
  'order-cancelled',
  'cod_confirm',
  'cod-confirm',
  'fulfillment',
];

/**
 * Returns true if this journey should NOT receive revenue attribution.
 * Checks playbookKey and sourceFlowId against known non-revenue pattern list.
 */
function isNonRevenue(playbookKey = '', sourceFlowId = '') {
  const haystack = `${String(playbookKey).toLowerCase()} ${String(sourceFlowId).toLowerCase()}`;
  return NON_REVENUE_PATTERNS.some((p) => haystack.includes(p));
}

/**
 * Backfill FollowUpSequence step delivery/read/failed timestamps from Meta status webhooks.
 * Now handles 'failed' status in addition to 'delivered' and 'read'.
 */
async function updateJourneyStepStatus({ clientId, messageId, status, timestamp, failureReason }) {
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
  } else if (status === 'failed') {
    $set[`${path}.status`] = 'failed';
    $set[`${path}.failedAt`] = ts;
    if (failureReason) {
      $set[`${path}.failureReason`] = String(failureReason);
    }
  } else {
    return false;
  }

  await FollowUpSequence.updateOne({ _id: seq._id }, { $set });
  log.debug(`updateJourneyStepStatus seq=${seq._id} step=${stepIdx} status=${status}`);
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
 * Prefers clickedAt > sentAt for most-recent touch determination.
 */
function latestJourneyTouch(sequences, orderDate, windowStart) {
  let best = null;
  for (const seq of sequences) {
    if (!seq.sourceFlowId) continue;
    const steps = seq.steps || [];
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const st = String(step.status || '');
      const isSent = st === 'sent' || !!step.sentAt;
      if (!isSent) continue;

      // Use most recent engagement as the touch time
      const touchAt = step.clickedAt
        ? new Date(step.clickedAt)
        : step.readAt
        ? new Date(step.readAt)
        : step.sentAt
        ? new Date(step.sentAt)
        : null;

      if (!touchAt) continue;
      if (touchAt < windowStart || touchAt > orderDate) continue;
      if (!best || touchAt > best.touchAt) {
        best = {
          sequenceId: seq._id,
          sourceFlowId: seq.sourceFlowId,
          leadId: seq.leadId,
          stepIndex: i,
          touchAt,
          sentAt: step.sentAt ? new Date(step.sentAt) : touchAt,
          channel: step.channel || 'whatsapp',
          playbookKey: seq.playbookKey || '',
          clickDriven: !!(step.clickedAt), // true when customer tapped a tracked link/button
        };
      }
    }
  }
  return best;
}

/**
 * Attribute Shopify order revenue to the most recent journey message.
 * - SKIPS attribution for transactional journey types (order_placed, etc.)
 * - Uses 30-day window for cart recovery, manual, marketing journeys
 * - Matches by phone variants + optionally by email/leadId
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

    const leadEmail = String(lead?.email || order?.customerEmail || '').trim().toLowerCase();

    if (!variants.length && !leadEmail) return null;

    const amount = Number(
      order?.totalPrice || order?.amount || order?.total_price || 0
    );
    if (!amount || amount <= 0) return null;

    const orderDate = new Date(order?.createdAt || order?.orderDate || Date.now());
    // Default 30-day attribution window (ATTRIBUTION_WINDOW_HOURS = 720h).
    // Per-journey override can be set via WhatsAppFlow.journeyPolicies.attributionWindowDays.
    const windowStart = new Date(
      orderDate.getTime() - ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000
    );

    // Build OR clauses for phone + email
    const phoneOr = variants.flatMap((v) => [{ phone: v }, { phone: `+${v}` }]);
    const contactOr = [...phoneOr];
    if (leadEmail) contactOr.push({ email: leadEmail });

    const sequences = await FollowUpSequence.find({
      clientId,
      sourceFlowId: { $ne: '' },
      $or: contactOr,
    })
      .select('sourceFlowId leadId playbookKey steps phone email')
      .lean();

    const touch = latestJourneyTouch(sequences, orderDate, windowStart);
    if (!touch?.sourceFlowId) return null;

    // Non-revenue journey types: skip attribution
    if (isNonRevenue(touch.playbookKey, touch.sourceFlowId)) {
      log.debug(
        `Skipping revenue attribution — non-revenue journey ${touch.sourceFlowId} (playbookKey: ${touch.playbookKey})`
      );
      return null;
    }

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
      !existing.excluded &&
      String(existing.sourceFlowId) === String(touch.sourceFlowId) &&
      Number(existing.amount || 0) === amount
    ) {
      return touch.sourceFlowId;
    }

    const journeyType =
      touch.playbookKey ||
      (touch.sourceFlowId.includes('cart') ? 'cart_abandoned' : 'marketing');

    await JourneyRevenueAttribution.findOneAndUpdate(
      { clientId, orderKey },
      {
        $set: {
          shopifyOrderId: String(order?.shopifyOrderId || order?.orderId || orderKey),
          sourceFlowId: touch.sourceFlowId,
          sequenceId: touch.sequenceId,
          leadId: touch.leadId,
          phone: variants[0] || '',
          email: leadEmail || '',
          amount,
          currency: order?.currency || 'INR',
          attributedAt: orderDate,
          lastMessageSentAt: touch.sentAt,
          attributionWindowHours: ATTRIBUTION_WINDOW_HOURS,
          attributionWindowDays: Math.round(ATTRIBUTION_WINDOW_HOURS / 24),
          channel: touch.channel,
          journeyType,
          source: 'shopify_webhook',
          excluded: false,
          clickDriven: touch.clickDriven === true,
        },
      },
      { upsert: true }
    );

    log.info(
      `Attributed ₹${amount} to journey ${touch.sourceFlowId} for order ${orderKey} (window=30d)`
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
  isNonRevenue,
  ATTRIBUTION_WINDOW_HOURS,
  NON_REVENUE_PATTERNS,
};
