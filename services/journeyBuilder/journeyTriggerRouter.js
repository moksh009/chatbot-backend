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
const { normalizeFilters } = require('./journeyNodeContract');
const { enqueueDueStepsForSequence } = require('../../utils/messaging/sequenceStepEnqueue');
const log = require('../../utils/core/logger')('JourneyTriggerRouter');

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

function isCodOrder(payload) {
  const gateways = payload?.payment_gateway_names || [];
  const gateway = String(payload?.gateway || payload?.payment_gateway || '');
  return gateways.some((g) => /cod|cash/i.test(String(g))) || /cod|cash/i.test(gateway);
}

/**
 * Match a blueprint's journeyTrigger.filters against the event payload.
 * Returns true if the blueprint should enroll.
 */
function filtersMatch(blueprintFilters, triggerType, payload) {
  const f = normalizeFilters(blueprintFilters || {});

  if (f.codOnly) {
    if (!isCodOrder(payload)) return false;
  }

  if (Array.isArray(f.productIds) && f.productIds.length > 0) {
    const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
    const orderProductIds = lineItems.map((li) => String(li?.product_id || '')).filter(Boolean);
    const matches = f.productIds.some((id) => orderProductIds.includes(String(id)));
    if (!matches) return false;
  }

  if (Number.isFinite(f.minOrderTotal) && f.minOrderTotal > 0) {
    const total = Number(payload?.total_price || payload?.subtotal_price || 0);
    if (total < f.minOrderTotal) return false;
  }

  return true;
}

/**
 * Write an OrderStatusSent dedup row for order-based journey triggers.
 * Uses upsert so the unique index prevents duplicates.
 * Returns { alreadySent: boolean }.
 */
async function checkAndMarkOrderSent(clientId, orderId, statusKey, phone) {
  if (!orderId || !statusKey) return { alreadySent: false };
  try {
    await OrderStatusSent.create({
      clientId,
      orderId,
      statusKey,
      channel: 'whatsapp',
      phone: phone || '',
    });
    return { alreadySent: false };
  } catch (err) {
    if (err?.code === 11000 || err?.name === 'MongoServerError') {
      return { alreadySent: true };
    }
    log.warn(`[JourneyTriggerRouter] OrderStatusSent upsert error for ${orderId}: ${err.message}`);
    return { alreadySent: false };
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
    return { enrolled: 0, skipped, errors: ['Missing required args'] };
  }

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
    return { enrolled: 0, skipped, errors };
  }

  const isOrderTrigger = triggerType !== 'cart_abandoned';
  const phone = isOrderTrigger ? extractPhone(payload) : String(payload?.phoneNumber || '').replace(/\D/g, '');
  const orderId = isOrderTrigger ? extractOrderId(payload) : '';
  const statusKey = TRIGGER_STATUS_KEY_MAP[triggerType] || `journey_${triggerType}`;

  for (const blueprint of blueprints) {
    const flowId = blueprint.flowId;
    const filters = blueprint?.journeyTrigger?.filters || {};

    // Filter matching
    if (!filtersMatch(filters, triggerType, payload)) {
      skipped.push(`${flowId}:filter_mismatch`);
      continue;
    }

    // Phone is required for WA sends
    if (!phone || phone.length < 8) {
      skipped.push(`${flowId}:no_phone`);
      continue;
    }

    // Order dedup: check OrderStatusSent
    if (isOrderTrigger && orderId) {
      const { alreadySent } = await checkAndMarkOrderSent(clientId, orderId, `${statusKey}_${flowId}`, phone);
      if (alreadySent) {
        skipped.push(`${flowId}:already_sent`);
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
      continue;
    }

    // Resolve lead
    let lead = isOrderTrigger
      ? await resolveLeadForOrder(clientId, phone, payload)
      : (payload._id ? payload : await AdLead.findById(payload._id || payload.leadId).select('_id phoneNumber email name').lean());

    if (!lead?._id) {
      skipped.push(`${flowId}:no_lead`);
      continue;
    }

    const leadId = lead._id;

    // Cart dedup: check active enrollment
    if (!isOrderTrigger) {
      const active = await hasActiveCartEnrollment(clientId, leadId, flowId);
      if (active) {
        skipped.push(`${flowId}:already_enrolled`);
        continue;
      }
    }

    // Enroll
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

      await enqueueDueStepsForSequence(sequence).catch(() => {});
      enrolled.push(flowId);
      log.info(`[JourneyTriggerRouter] Enrolled lead ${String(leadId)} in ${flowId} (trigger: ${triggerType})`);
    } catch (err) {
      errors.push(`${flowId}:enroll_error:${err.message}`);
      log.error(`[JourneyTriggerRouter] Enroll failed for ${flowId}: ${err.message}`);
    }
  }

  return { enrolled: enrolled.length, enrolledFlowIds: enrolled, skipped, errors };
}

module.exports = {
  routeToJourneyBlueprints,
};
