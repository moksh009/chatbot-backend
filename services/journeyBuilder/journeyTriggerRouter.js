'use strict';

/**
 * Journey Trigger Router — bridges Shopify webhook events and cart cron
 * to published journey blueprints.
 *
 * Core function: routeToJourneyBlueprints(clientId, triggerType, payload)
 *
 * Dedup safety (§H.7 winner: journey router wins):
 *   - order triggers: write OrderStatusSent row with channel='whatsapp' *before*
 *     returning, so SAC handler (processOrderStatusAutomations) finds the row
 *     and skips duplicate.
 *   - cart trigger: check existing active FollowUpSequence with same sourceFlowId
 *     + leadId before enrolling.
 *
 * Never throws — errors are logged and returned in `errors[]`.
 */

const moment = require('moment');
const mongoose = require('mongoose');
const WhatsAppFlow = require('../../models/WhatsAppFlow');
const FollowUpSequence = require('../../models/FollowUpSequence');
const OrderStatusSent = require('../../models/OrderStatusSent');
const AdLead = require('../../models/AdLead');
const { compileGraphToSteps } = require('./compileGraphToSteps');
const { evaluateTriggerRules } = require('./journeyTriggerEvaluator');
const { enqueueDueStepsForSequence } = require('../../utils/messaging/sequenceStepEnqueue');
const { checkJourneyEnrollmentAllowed } = require('./journeyPolicyService');
const log = require('../../utils/core/logger')('JourneyTriggerRouter');

const MAX_ACTIVE_SEQUENCES = 2;

/** Map from internal journey trigger type → OrderStatusSent statusKey for dedup. */
const TRIGGER_STATUS_KEY_MAP = {
  order_placed: 'journey_order_placed',
  order_shipped: 'journey_order_shipped',
  order_delivered: 'journey_order_delivered',
};

/**
 * Extract and normalise a phone string from a Shopify order payload.
 */
function extractPhone(payload) {
  const raw =
    payload?.phone ||
    payload?.customer?.phone ||
    payload?.billing_address?.phone ||
    payload?.shipping_address?.phone ||
    '';
  return String(raw).replace(/\D/g, '');
}

function extractOrderId(payload) {
  return String(payload?.name || payload?.id || payload?.orderId || '');
}

/**
 * Match a blueprint's journeyTrigger.filters against the event payload.
 * Returns true if the blueprint should enroll.
 */
async function filtersMatch(clientId, blueprintFilters, triggerType, payload) {
  const { match } = await evaluateTriggerRules({
    clientId,
    triggerType,
    payload,
    filters: blueprintFilters || {},
  });
  return match;
}

/**
 * Read-only check: has this order already been sent for this statusKey?
 * Does NOT write anything — safe to call at the top of the loop.
 */
async function isOrderAlreadySent(clientId, orderId, statusKey) {
  if (!orderId || !statusKey) return false;
  try {
    const existing = await OrderStatusSent.findOne({ clientId, orderId, statusKey })
      .select('_id')
      .lean();
    return !!existing;
  } catch (err) {
    log.warn(`[JourneyTriggerRouter] OrderStatusSent check error for ${orderId}: ${err.message}`);
    return true;
  }
}

/**
 * Write the OrderStatusSent dedup row AFTER a successful enrollment.
 * Duplicate key errors are silently ignored (another concurrent job won).
 */
async function markOrderSent(clientId, orderId, statusKey, phone) {
  if (!orderId || !statusKey) return;
  try {
    await OrderStatusSent.create({
      clientId,
      orderId,
      statusKey,
      channel: 'whatsapp',
      phone: phone || '',
    });
  } catch (err) {
    if (err?.code === 11000 || err?.name === 'MongoServerError') return; // already written — fine
    log.warn(`[JourneyTriggerRouter] OrderStatusSent write error for ${orderId}: ${err.message}`);
  }
}

/**
 * Find or create an AdLead for the given phone number.
 * Minimal upsert — phone only. If a lead already exists by phone, reuse it.
 */
async function resolveLeadForOrder(clientId, phone, payload) {
  if (!phone || phone.length < 8) return null;
  const name =
    payload?.customer?.first_name ||
    payload?.billing_address?.first_name ||
    'Customer';
  const email =
    payload?.customer?.email || payload?.billing_address?.email || '';

  const existing = await AdLead.findOne({ clientId, phoneNumber: new RegExp(phone.slice(-10) + '$') })
    .select('_id phoneNumber email')
    .lean();
  if (existing) return existing;

  try {
    const lead = await AdLead.create({
      clientId,
      name,
      phoneNumber: phone,
      email,
      source: 'order_journey_auto',
    });
    return lead.toObject ? lead.toObject() : lead;
  } catch {
    return AdLead.findOne({ clientId, phoneNumber: new RegExp(phone.slice(-10) + '$') })
      .select('_id phoneNumber email')
      .lean();
  }
}

/**
 * Check if a lead already has an active FollowUpSequence from this blueprint.
 */
async function hasActiveCartEnrollment(clientId, leadId, flowId) {
  const existing = await FollowUpSequence.findOne({
    clientId,
    leadId: mongoose.Types.ObjectId.isValid(String(leadId)) ? new mongoose.Types.ObjectId(String(leadId)) : null,
    sourceFlowId: flowId,
    status: 'active',
  }).select('_id').lean();
  return !!existing;
}

async function countActiveSequencesForLead(clientId, leadId) {
  return FollowUpSequence.countDocuments({
    clientId,
    leadId: mongoose.Types.ObjectId.isValid(String(leadId)) ? new mongoose.Types.ObjectId(String(leadId)) : leadId,
    status: 'active',
  });
}

async function syncLeadActiveSequenceFlag(clientId, leadId) {
  if (!leadId) return;
  const count = await countActiveSequencesForLead(clientId, leadId);
  await AdLead.findByIdAndUpdate(leadId, {
    $set: { 'metaData.hasActiveSequence': count > 0 },
  }).catch((err) => {
    log.warn(`[JourneyTriggerRouter] hasActiveSequence sync failed: ${err.message}`);
  });
}

/**
 * True when at least one live order_placed journey would enroll for this order payload.
 * Used by SAC to avoid blanket-skipping order confirmation when filters do not match.
 */
async function anyOrderPlacedJourneyWouldMatch(clientId, payload) {
  try {
    const blueprints = await WhatsAppFlow.find({
      clientId,
      flowType: 'journey',
      status: 'PUBLISHED',
      isActive: true,
      'journeyTrigger.type': 'order_placed',
    })
      .select('journeyTrigger')
      .lean();
    for (const blueprint of blueprints) {
      const filters = blueprint?.journeyTrigger?.filters || {};
      if (await filtersMatch(clientId, filters, 'order_placed', payload)) {
        return true;
      }
    }
    return false;
  } catch (err) {
    log.warn(`[JourneyTriggerRouter] order_placed match probe failed: ${err.message}`);
    return false;
  }
}

/**
 * Core routing function.
 *
 * @param {string} clientId
 * @param {'cart_abandoned'|'order_placed'|'order_shipped'|'order_delivered'} triggerType
 * @param {object} payload  — Shopify order payload or abandoned cart lead object
 * @returns {Promise<{ enrolled: number, skipped: string[], errors: string[] }>}
 */
async function routeToJourneyBlueprints(clientId, triggerType, payload) {
  const enrolled = [];
  const skipped = [];
  const errors = [];

  if (!clientId || !triggerType || !payload) {
    const out = { enrolled: 0, skipped, errors: ['Missing required args'] };
    log.warn('[JourneyTriggerRouter] route skipped — missing args', { clientId, triggerType, hasPayload: !!payload });
    return out;
  }

  const isOrderTrigger = triggerType !== 'cart_abandoned';
  const phone = isOrderTrigger ? extractPhone(payload) : String(payload?.phoneNumber || '').replace(/\D/g, '');
  const orderId = isOrderTrigger ? extractOrderId(payload) : '';

  log.info('[JourneyTriggerRouter] route start', {
    clientId,
    triggerType,
    orderId: orderId || null,
    phoneTail: phone ? phone.slice(-4) : null,
    hasPhone: phone.length >= 8,
  });

  let blueprints;
  try {
    blueprints = await WhatsAppFlow.find({
      clientId,
      flowType: 'journey',
      status: 'PUBLISHED',
      isActive: true,
      'journeyTrigger.type': triggerType,
    }).lean();
  } catch (err) {
    log.error(`[JourneyTriggerRouter] Blueprint query failed: ${err.message}`);
    return { enrolled: 0, skipped, errors: [err.message] };
  }

  if (!blueprints.length) {
    log.info('[JourneyTriggerRouter] no matching blueprints', {
      clientId,
      triggerType,
      hint: 'Publish a journey with this trigger type and Live toggle ON',
    });
    return { enrolled: 0, skipped, errors };
  }

  log.info('[JourneyTriggerRouter] blueprints matched', {
    clientId,
    triggerType,
    count: blueprints.length,
    flowIds: blueprints.map((b) => b.flowId),
  });

  const statusKey = TRIGGER_STATUS_KEY_MAP[triggerType] || `journey_${triggerType}`;

  for (const blueprint of blueprints) {
    const flowId = blueprint.flowId;
    const filters = blueprint?.journeyTrigger?.filters || {};

    // Filter matching
    if (!(await filtersMatch(clientId, filters, triggerType, payload))) {
      skipped.push(`${flowId}:filter_mismatch`);
      log.info('[JourneyTriggerRouter] skipped filter_mismatch', { clientId, flowId, triggerType });
      continue;
    }

    // Phone is required for WA sends
    if (!phone || phone.length < 8) {
      skipped.push(`${flowId}:no_phone`);
      log.warn('[JourneyTriggerRouter] skipped no_phone', {
        clientId,
        flowId,
        orderId,
        hint: 'Shopify order must include customer phone on billing/shipping/customer',
      });
      continue;
    }

    // Order dedup: read-only check BEFORE doing any work
    if (isOrderTrigger && orderId) {
      const alreadySent = await isOrderAlreadySent(clientId, orderId, `${statusKey}_${flowId}`);
      if (alreadySent) {
        skipped.push(`${flowId}:already_sent`);
        log.info('[JourneyTriggerRouter] skipped already_sent', { clientId, flowId, orderId });
        continue;
      }
    }

    // Compile graph → steps
    const nodes = blueprint.publishedNodes?.length ? blueprint.publishedNodes : blueprint.nodes || [];
    const edges = blueprint.publishedEdges?.length ? blueprint.publishedEdges : blueprint.edges || [];
    let compiled;
    try {
      compiled = compileGraphToSteps({ nodes, edges, anchorTime: new Date() });
    } catch (err) {
      errors.push(`${flowId}:compile_error:${err.message}`);
      continue;
    }

    if (!compiled.steps.length) {
      skipped.push(`${flowId}:no_steps`);
      log.warn('[JourneyTriggerRouter] skipped no_steps', { clientId, flowId });
      continue;
    }

    // Resolve lead
    let lead = isOrderTrigger
      ? await resolveLeadForOrder(clientId, phone, payload)
      : (payload._id ? payload : await AdLead.findById(payload._id || payload.leadId).select('_id phoneNumber email name').lean());

    if (!lead?._id) {
      skipped.push(`${flowId}:no_lead`);
      log.warn('[JourneyTriggerRouter] skipped no_lead', { clientId, flowId, phoneTail: phone.slice(-4) });
      continue;
    }

    const leadId = lead._id;

    const policyCheck = await checkJourneyEnrollmentAllowed({
      clientId,
      flow: blueprint,
      leadId,
      orderPayload: isOrderTrigger ? payload : null,
      triggerType,
      enrollmentSource: 'auto',
      sourceOrderId: orderId || null,
    });
    if (!policyCheck.allowed) {
      skipped.push(`${flowId}:${policyCheck.reason || 'policy_blocked'}`);
      log.info('[JourneyTriggerRouter] skipped policy', {
        clientId,
        flowId,
        leadId: String(leadId),
        reason: policyCheck.reason,
      });
      continue;
    }

    const activeCount = await countActiveSequencesForLead(clientId, leadId);
    if (activeCount >= MAX_ACTIVE_SEQUENCES) {
      skipped.push(`${flowId}:active_sequence_limit`);
      log.info('[JourneyTriggerRouter] skipped active_sequence_limit', {
        clientId,
        flowId,
        leadId: String(leadId),
        activeCount,
      });
      continue;
    }

    // Cart dedup: check active enrollment
    if (!isOrderTrigger) {
      const active = await hasActiveCartEnrollment(clientId, leadId, flowId);
      if (active) {
        skipped.push(`${flowId}:already_enrolled`);
        log.info('[JourneyTriggerRouter] skipped already_enrolled', { clientId, flowId, leadId: String(leadId) });
        continue;
      }
    }

    // Enroll — create the sequence FIRST, then write the dedup row
    try {
      const mappedSteps = compiled.steps.map((s) => ({ ...s, status: 'pending' }));
      const sequence = await FollowUpSequence.create({
        clientId,
        leadId,
        phone: String(phone),
        email: String(lead.email || ''),
        name: blueprint.name || 'Journey enrollment',
        type: 'custom',
        cancelOnReply: compiled.cancelOnReply !== false,
        sourceFlowId: flowId,
        playbookKey: blueprint.playbookKey || '',
        sourceOrderId: orderId,
        enrollment: {
          mode: 'blueprint',
          blueprint: { flowId, name: blueprint.name },
        },
        steps: mappedSteps,
      });

      // Write dedup row only after successful enrollment so a failed create
      // does not permanently block retries via the OrderStatusSent check above.
      if (isOrderTrigger && orderId) {
        await markOrderSent(clientId, orderId, `${statusKey}_${flowId}`, phone);
      }

      const queued = await enqueueDueStepsForSequence(sequence).catch((enqueueErr) => {
        log.error(`[JourneyTriggerRouter] enqueue failed for ${flowId}: ${enqueueErr.message}`);
        return 0;
      });
      enrolled.push(flowId);
      await syncLeadActiveSequenceFlag(clientId, leadId);
      log.info('[JourneyTriggerRouter] enrolled', {
        clientId,
        flowId,
        triggerType,
        leadId: String(leadId),
        sequenceId: String(sequence._id),
        stepCount: mappedSteps.length,
        firstSendAt: mappedSteps[0]?.sendAt || null,
        queuedSteps: queued,
      });
    } catch (err) {
      errors.push(`${flowId}:enroll_error:${err.message}`);
      log.error(`[JourneyTriggerRouter] Enroll failed for ${flowId}: ${err.message}`);
    }
  }

  const result = { enrolled: enrolled.length, enrolledFlowIds: enrolled, skipped, errors };
  log.info('[JourneyTriggerRouter] route complete', {
    clientId,
    triggerType,
    orderId: orderId || null,
    ...result,
  });
  return result;
}

module.exports = {
  routeToJourneyBlueprints,
  anyOrderPlacedJourneyWouldMatch,
};
