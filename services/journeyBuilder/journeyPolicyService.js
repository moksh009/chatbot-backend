'use strict';

/**
 * Journey blueprint enrollment policies — repeat windows, caps, cooldown, min order value.
 * Scoped to flowType journey + sourceFlowId (blueprint).
 */

const mongoose = require('mongoose');
const FollowUpSequence = require('../../models/FollowUpSequence');
const WhatsAppFlow = require('../../models/WhatsAppFlow');
const AdLead = require('../../models/AdLead');
const log = require('../../utils/core/logger')('JourneyPolicyService');

const ORDER_TRIGGER_TYPES = new Set(['order_placed', 'order_shipped', 'order_delivered']);

function toObjectId(id) {
  const s = String(id || '');
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function orderAmountFromPayload(orderPayload) {
  if (!orderPayload) return null;
  const raw = orderPayload.total_price ?? orderPayload.subtotal_price ?? orderPayload.amount;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function repeatSinceDate(repeat) {
  const since = new Date();
  if (repeat === 'once_per_month') since.setDate(since.getDate() - 30);
  else if (repeat === 'once_per_year') since.setFullYear(since.getFullYear() - 1);
  else return null;
  return since;
}

async function checkRepeatWindow({ clientId, flowId, leadId, policies }) {
  const repeat = policies?.repeatPerCustomer || 'never';
  const oid = toObjectId(leadId);
  if (!oid) return { allowed: true };

  const baseQuery = { clientId, leadId: oid, sourceFlowId: String(flowId) };

  if (repeat === 'never') {
    const prior = await FollowUpSequence.findOne({
      ...baseQuery,
      status: { $in: ['active', 'completed'] },
    })
      .select('_id')
      .lean();
    if (prior) return { allowed: false, reason: 'repeat_window' };
    return { allowed: true };
  }

  const since = repeatSinceDate(repeat);
  if (!since) return { allowed: true };

  const recent = await FollowUpSequence.findOne({
    ...baseQuery,
    createdAt: { $gte: since },
  })
    .select('_id')
    .lean();
  if (recent) return { allowed: false, reason: 'repeat_window' };
  return { allowed: true };
}

async function checkMaxEnrollments({ clientId, flowId, leadId, policies }) {
  const max = policies?.maxEnrollmentsPerLead;
  if (max == null || !Number.isFinite(Number(max)) || Number(max) <= 0) {
    return { allowed: true };
  }
  const oid = toObjectId(leadId);
  if (!oid) return { allowed: true };

  const count = await FollowUpSequence.countDocuments({
    clientId,
    leadId: oid,
    sourceFlowId: String(flowId),
  });
  if (count >= Number(max)) {
    return { allowed: false, reason: 'max_enrollments' };
  }
  return { allowed: true };
}

async function checkReentryCooldown({ clientId, flowId, leadId, policies }) {
  const days = policies?.reentryCooldownDays;
  if (days == null || !Number.isFinite(Number(days)) || Number(days) <= 0) {
    return { allowed: true };
  }
  const oid = toObjectId(leadId);
  if (!oid) return { allowed: true };

  const since = new Date();
  since.setDate(since.getDate() - Number(days));

  const recentEnded = await FollowUpSequence.findOne({
    clientId,
    leadId: oid,
    sourceFlowId: String(flowId),
    status: { $in: ['completed', 'cancelled'] },
    $or: [
      { cancelledAt: { $gte: since } },
      { updatedAt: { $gte: since } },
    ],
  })
    .sort({ updatedAt: -1 })
    .select('_id')
    .lean();

  if (recentEnded) return { allowed: false, reason: 'cooldown' };
  return { allowed: true };
}

function checkMinOrderValue({ policies, orderPayload, triggerType }) {
  const min = policies?.minOrderValue;
  if (min == null || !Number.isFinite(Number(min)) || Number(min) <= 0) {
    return { allowed: true };
  }
  if (triggerType && !ORDER_TRIGGER_TYPES.has(triggerType)) {
    return { allowed: true };
  }
  const amount = orderAmountFromPayload(orderPayload);
  if (amount == null) return { allowed: true };
  if (amount < Number(min)) {
    return { allowed: false, reason: 'min_order_value' };
  }
  return { allowed: true };
}

/**
 * Check all journey enrollment policies for a lead + blueprint.
 */
async function checkJourneyEnrollmentAllowed({
  clientId,
  flow,
  leadId,
  orderPayload = null,
  triggerType = null,
}) {
  if (!clientId || !flow || !leadId) {
    return { allowed: false, reason: 'missing_args' };
  }

  const flowId = String(flow.flowId || flow._id || '');
  const policies = flow.journeyPolicies || {};
  const trigType = triggerType || flow?.journeyTrigger?.type || null;

  const minCheck = checkMinOrderValue({ policies, orderPayload, triggerType: trigType });
  if (!minCheck.allowed) return minCheck;

  const repeatCheck = await checkRepeatWindow({ clientId, flowId, leadId, policies });
  if (!repeatCheck.allowed) return repeatCheck;

  const maxCheck = await checkMaxEnrollments({ clientId, flowId, leadId, policies });
  if (!maxCheck.allowed) return maxCheck;

  const cooldownCheck = await checkReentryCooldown({ clientId, flowId, leadId, policies });
  if (!cooldownCheck.allowed) return cooldownCheck;

  return { allowed: true };
}

/**
 * Cancel active journey enrollments for an order when exit condition order_cancelled fires.
 */
async function cancelJourneyEnrollmentsForOrder({ clientId, orderId, reason = 'order_cancelled' }) {
  if (!clientId || !orderId) return { cancelled: 0 };

  const orderKey = String(orderId).trim();
  if (!orderKey) return { cancelled: 0 };

  const activeSeqs = await FollowUpSequence.find({
    clientId,
    sourceOrderId: orderKey,
    status: 'active',
  })
    .select('_id leadId sourceFlowId')
    .lean();

  if (!activeSeqs.length) return { cancelled: 0 };

  const flowIds = [...new Set(activeSeqs.map((s) => s.sourceFlowId).filter(Boolean))];
  const flows = flowIds.length
    ? await WhatsAppFlow.find({ clientId, flowId: { $in: flowIds } })
        .select('flowId journeyTrigger')
        .lean()
    : [];
  const flowMap = new Map(flows.map((f) => [String(f.flowId), f]));

  let cancelled = 0;
  const now = new Date();

  for (const seq of activeSeqs) {
    const flow = flowMap.get(String(seq.sourceFlowId));
    const exitConditions = flow?.journeyTrigger?.exitConditions || [];
    const jt = flow?.journeyTrigger;
    const hasExit =
      Array.isArray(exitConditions) && exitConditions.includes('order_cancelled');
    const legacyCancel = jt?.cancelOnOrderCancelled === true;
    if (!hasExit && !legacyCancel) continue;

    await FollowUpSequence.updateOne(
      { _id: seq._id, clientId, status: 'active' },
      {
        $set: {
          status: 'cancelled',
          cancelledReason: reason,
          cancelledAt: now,
        },
      }
    );
    cancelled += 1;

    if (seq.leadId) {
      const count = await FollowUpSequence.countDocuments({
        clientId,
        leadId: seq.leadId,
        status: 'active',
      });
      await AdLead.findByIdAndUpdate(seq.leadId, {
        $set: { 'metaData.hasActiveSequence': count > 0 },
      }).catch((err) => {
        log.warn(`hasActiveSequence sync failed: ${err.message}`);
      });
    }
  }

  if (cancelled) {
    log.info('[JourneyPolicy] cancelled enrollments for order', {
      clientId,
      orderId: orderKey,
      cancelled,
      reason,
    });
  }

  return { cancelled };
}

module.exports = {
  checkJourneyEnrollmentAllowed,
  cancelJourneyEnrollmentsForOrder,
  checkRepeatWindow,
  checkMaxEnrollments,
  checkReentryCooldown,
  checkMinOrderValue,
  orderAmountFromPayload,
};
