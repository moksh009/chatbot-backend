'use strict';

const CodToPrepaidConversion = require('../../../models/CodToPrepaidConversion');
const FollowUpSequence = require('../../../models/FollowUpSequence');
const {
  createDraftOrder,
  deleteDraftOrder,
  gidToNumericId,
} = require('./codToPrepaidShopify');
const { buildCodPrepaidAppliedDiscount } = require('./codToPrepaidDiscount');
const { updateSequenceContext, assertCodPrepaidEnrollmentContext } = require('../sequenceContextService');
const { buildJourneySequenceWhatsAppPayload } = require('../journeySequenceWhatsApp');
const { sendEnvelope } = require('../../../utils/messaging/sendEnvelope');
const log = require('../../../utils/core/logger')('CodToPrepaidExecutor');

const TERMINAL_STATUSES = new Set([
  'converted',
  'expired_by_timer',
  'expired_by_fulfillment',
  'draft_creation_failed',
  'message_send_failed',
]);

const ACTIVE_STATUSES = new Set([
  'draft_order_pending',
  'draft_order_created',
  'message_sent',
]);

function extractNumericOrderId(snap = {}) {
  if (snap.shopifyOrderNumericId) return String(snap.shopifyOrderNumericId);
  const raw = snap.orderId || '';
  if (/^\d+$/.test(String(raw))) return String(raw);
  const fromGid = snap.shopifyOrderGid ? gidToNumericId(snap.shopifyOrderGid) : '';
  return fromGid || '';
}

function buildDraftOrderInput(snap = {}, discountConfig = {}) {
  const numericId = extractNumericOrderId(snap);
  const tag = numericId ? `Converted_From_COD_${numericId}` : '';

  const lineItems = (snap.lineItems || [])
    .map((li) => {
      const variantGid =
        li.variantGid ||
        (li.variant_id ? `gid://shopify/ProductVariant/${li.variant_id}` : '');
      if (!variantGid) return null;
      return {
        variantId: variantGid,
        quantity: Number(li.quantity) || 1,
      };
    })
    .filter(Boolean);

  const input = {
    lineItems,
    tags: tag ? [tag] : [],
  };

  const appliedDiscount = buildCodPrepaidAppliedDiscount(discountConfig);
  if (appliedDiscount) {
    input.appliedDiscount = appliedDiscount;
  }

  if (snap.customerGid) {
    input.customerId = snap.customerGid;
  } else if (snap.customer && /^\d+$/.test(String(snap.customer))) {
    input.customerId = `gid://shopify/Customer/${snap.customer}`;
  }

  const addr = snap.shippingAddress;
  if (addr && typeof addr === 'object') {
    input.shippingAddress = {
      address1: addr.address1 || '',
      address2: addr.address2 || '',
      city: addr.city || '',
      province: addr.province || '',
      countryCode: addr.countryCode || addr.country || '',
      zip: addr.zip || '',
    };
    if (addr.first_name || addr.firstName) {
      input.shippingAddress.firstName = addr.first_name || addr.firstName;
    }
    if (addr.last_name || addr.lastName) {
      input.shippingAddress.lastName = addr.last_name || addr.lastName;
    }
    if (addr.phone) input.shippingAddress.phone = addr.phone;
  }

  return { input, numericId, tag };
}

function computeExpiresAt(freezeMode, freezeDurationValue, freezeDurationUnit) {
  if (freezeMode !== 'by_duration') return null;
  const n = Number(freezeDurationValue);
  if (!Number.isFinite(n) || n < 1) return null;
  const unit = String(freezeDurationUnit || 'h').toLowerCase();
  const minutes = unit === 'm' || unit === 'minutes' ? n : n * 60;
  return new Date(Date.now() + minutes * 60 * 1000);
}

async function recordOutcome(sequenceId, graphNodeId, outcome, clientId) {
  const seq = await FollowUpSequence.findById(sequenceId).select('sequenceContext clientId').lean();
  if (!seq) return;
  const cid = clientId || seq.clientId;
  const outcomes = {
    ...(seq.sequenceContext?.codPrepaidOutcomes || {}),
    [String(graphNodeId)]: outcome,
  };
  await FollowUpSequence.updateOne(
    { _id: sequenceId, clientId: cid },
    {
      $set: {
        'sequenceContext.codPrepaidOutcomes': outcomes,
        [`sequenceContext.codPrepaidOutcome_${graphNodeId}`]: outcome,
      },
    }
  );
}

/**
 * Execute COD → Prepaid journey step (Phase 1 — synchronous).
 * Returns { ok, outcome: 'message_sent'|'failed', reason?, conversionId? }
 */
async function executeCodToPrepaidStep({ client, clientId, step, seq, lead }) {
  const graphNodeId = String(step.graphNodeId || '');

  const contextCheck = assertCodPrepaidEnrollmentContext(seq, lead);
  if (!contextCheck.ok) {
    log.warn('COD prepaid failed — enrollment context incomplete', {
      clientId,
      enrollmentId: String(seq?._id || ''),
      missing: contextCheck.missing,
    });
    return {
      ok: false,
      outcome: 'failed',
      reason: contextCheck.reason || 'missing_cod_prepaid_context',
    };
  }

  const snap = seq?.sequenceContext?.webhookSnapshot;
  const phone =
    seq?.sequenceContext?.normalizedPhone ||
    lead?.phoneNumber ||
    seq?.phone ||
    '';

  const numericOrderId = extractNumericOrderId(snap);
  const orderGid =
    snap.shopifyOrderGid ||
    (numericOrderId ? `gid://shopify/Order/${numericOrderId}` : '');

  if (!numericOrderId || !orderGid) {
    return { ok: false, outcome: 'failed', reason: 'missing_order_id' };
  }

  const existingActive = await CodToPrepaidConversion.findOne({
    clientId,
    $or: [
      { enrollmentId: String(seq._id), status: { $in: [...ACTIVE_STATUSES] } },
      {
        contactPhone: String(phone).replace(/\D/g, ''),
        originalCodOrderId: numericOrderId,
        status: { $in: [...ACTIVE_STATUSES] },
      },
      { originalCodOrderId: numericOrderId, status: { $in: [...ACTIVE_STATUSES] } },
    ],
  }).lean();

  if (existingActive) {
    log.warn('COD prepaid skipped — active conversion exists for enrollment or order', {
      clientId,
      enrollmentId: String(seq._id),
      conversionId: String(existingActive._id),
    });
    await recordOutcome(seq._id, graphNodeId, 'message_sent', clientId);
    return { ok: true, outcome: 'message_sent', conversionId: String(existingActive._id), skipped: true };
  }

  const freezeMode = step.freezeMode || 'by_duration';
  const templateName = String(step.templateName || '').trim();
  const templateId = String(step.metaTemplateId || step.templateId || '').trim();
  const journeyId = String(seq.sourceFlowId || seq.enrollment?.blueprint?.flowId || '');

  if (!templateName) {
    return { ok: false, outcome: 'failed', reason: 'missing_template' };
  }

  let conversion = await CodToPrepaidConversion.create({
    clientId,
    journeyId,
    enrollmentId: String(seq._id),
    contactPhone: String(phone),
    graphNodeId,
    originalCodOrderId: numericOrderId,
    originalCodOrderName: String(snap.orderName || snap.orderId || ''),
    originalCodOrderGid: orderGid,
    metaTemplateId: templateId || templateName,
    metaTemplateName: templateName,
    freezeMode,
    status: 'draft_order_pending',
  });

  const { input } = buildDraftOrderInput(snap, {
    discountValue: step.discountValue,
    discountValueType: step.discountValueType,
    discountName: step.discountName,
  });

  let draftResult;
  try {
    draftResult = await createDraftOrder(clientId, input);
  } catch (err) {
    await CodToPrepaidConversion.findByIdAndUpdate(conversion._id, {
      $set: {
        status: 'draft_creation_failed',
        lastErrorMessage: err.message,
        lastErrorAt: new Date(),
      },
    });
    log.error('draftOrderCreate exception', {
      clientId,
      journeyId,
      enrollmentId: String(seq._id),
      error: err.message,
      rateLimited: /429|throttl|rate limit/i.test(String(err.message || '')),
    });
    await recordOutcome(seq._id, graphNodeId, 'failed', clientId);
    return { ok: false, outcome: 'failed', reason: err.message, conversionId: String(conversion._id) };
  }

  if (!draftResult.ok || !draftResult.draftOrder?.invoiceUrl) {
    const msg = draftResult.userErrors?.[0]?.message || 'draft_order_create_failed';
    await CodToPrepaidConversion.findByIdAndUpdate(conversion._id, {
      $set: {
        status: 'draft_creation_failed',
        lastErrorMessage: msg,
        lastErrorAt: new Date(),
      },
    });
    log.error('draftOrderCreate userErrors', {
      clientId,
      journeyId,
      enrollmentId: String(seq._id),
      userErrors: draftResult.userErrors,
    });
    await recordOutcome(seq._id, graphNodeId, 'failed', clientId);
    return { ok: false, outcome: 'failed', reason: msg, conversionId: String(conversion._id) };
  }

  const draft = draftResult.draftOrder;
  const draftGid = String(draft.id);
  const invoiceUrl = String(draft.invoiceUrl);
  const expiresAt =
    freezeMode === 'by_duration'
      ? computeExpiresAt(freezeMode, step.freezeDurationValue, step.freezeDurationUnit)
      : null;

  conversion = await CodToPrepaidConversion.findByIdAndUpdate(
    conversion._id,
    {
      $set: {
        draftOrderId: gidToNumericId(draftGid),
        draftOrderGid: draftGid,
        draftOrderName: draft.name || '',
        draftOrderInvoiceUrl: invoiceUrl,
        status: 'draft_order_created',
        draftOrderCreatedAt: new Date(),
        expiresAt,
      },
    },
    { new: true }
  );

  await updateSequenceContext(seq._id, 'draftInvoiceUrl', invoiceUrl, { clientId });
  await updateSequenceContext(seq._id, 'codToPrepaidConversionId', String(conversion._id), { clientId });

  const waStep = {
    ...step,
    type: 'whatsapp',
    templateName,
    hasUrlButton: true,
    urlButtonDestination: invoiceUrl,
    requiresWebhookSnapshot: false,
  };

  let payload;
  try {
    payload = await buildJourneySequenceWhatsAppPayload({
      client,
      clientId,
      step: waStep,
      lead,
      seq,
    });
  } catch (buildErr) {
    await CodToPrepaidConversion.findByIdAndUpdate(conversion._id, {
      $set: {
        status: 'message_send_failed',
        lastErrorMessage: buildErr.message,
        lastErrorAt: new Date(),
      },
    });
    await deleteDraftOrder(clientId, draftGid).catch((delErr) => {
      log.error('COD prepaid: WA payload build failed and draft cleanup failed', {
        clientId,
        journeyId,
        enrollmentId: String(seq._id),
        conversionId: String(conversion._id),
        buildError: buildErr.message,
        deleteError: delErr.message,
      });
    });
    await recordOutcome(seq._id, graphNodeId, 'failed', clientId);
    return { ok: false, outcome: 'failed', reason: buildErr.message, conversionId: String(conversion._id) };
  }

  try {
    const result = await sendEnvelope({
      client,
      clientId,
      channel: 'whatsapp',
      phone,
      intent: 'utility',
      templateName: payload.templateName,
      templateLanguage: payload.templateLanguage || 'en',
      components: payload.components,
      meta: {
        source: 'journey_cod_to_prepaid',
        sequenceId: String(seq._id),
        conversionId: String(conversion._id),
      },
    });

    if (!result?.ok && result?.outcome !== 'sent') {
      throw new Error(result?.reason || result?.message || 'whatsapp_send_failed');
    }
  } catch (sendErr) {
    await CodToPrepaidConversion.findByIdAndUpdate(conversion._id, {
      $set: {
        status: 'message_send_failed',
        lastErrorMessage: sendErr.message,
        lastErrorAt: new Date(),
      },
    });
    try {
      await deleteDraftOrder(clientId, draftGid);
    } catch (delErr) {
      log.error('COD prepaid: WhatsApp send failed and draft cleanup failed', {
        clientId,
        journeyId,
        enrollmentId: String(seq._id),
        conversionId: String(conversion._id),
        waError: sendErr.message,
        deleteError: delErr.message,
      });
    }
    await recordOutcome(seq._id, graphNodeId, 'failed', clientId);
    return { ok: false, outcome: 'failed', reason: sendErr.message, conversionId: String(conversion._id) };
  }

  await CodToPrepaidConversion.findByIdAndUpdate(conversion._id, {
    $set: {
      status: 'message_sent',
      messageSentAt: new Date(),
    },
  });

  await recordOutcome(seq._id, graphNodeId, 'message_sent', clientId);

  return {
    ok: true,
    outcome: 'message_sent',
    conversionId: String(conversion._id),
    invoiceUrl,
  };
}

module.exports = {
  executeCodToPrepaidStep,
  extractNumericOrderId,
  buildDraftOrderInput,
  computeExpiresAt,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
};
