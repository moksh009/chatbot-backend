'use strict';

/**
 * Journey Interactive Router — handles button taps that originated from
 * journey enrollment templates (COD confirm / cancel, and generic journey steps).
 *
 * Entry point: handleJourneyButtonTap(clientId, phone, buttonPayload)
 *
 * Payload formats supported:
 *   NEW  — `jrn_{enrollmentId}_{stepIndex}_{action}`
 *   LEGACY — `rto_cod_confirm_{orderId}` / `rto_cod_cancel_{orderId}`
 *
 * Actions:
 *   cod_confirm — mark order confirmed; advance FollowUpSequence to next step
 *   cod_cancel  — cancel Shopify order via rtoProtectionService; cancel enrollment
 *   advance     — generic advance (future extension)
 *
 * Idempotent: if step status != 'pending'/'awaiting' already, returns { alreadyHandled: true }.
 * Returns `{ claimed: true }` when this router owns the payload (caller should skip dualBrainEngine).
 * Returns `{ claimed: false }` for unknown / legacy-RTO payloads handled elsewhere.
 */

const mongoose = require('mongoose');
const FollowUpSequence = require('../../models/FollowUpSequence');
const log = require('../../utils/core/logger')('JourneyInteractiveRouter');

/** Regex for new journey button payloads: jrn_{enrollId}_{stepIdx}_{action} */
const JRN_BUTTON_RE = /^jrn_([a-f0-9]{24})_(\d+)_([\w]+)$/i;

/**
 * Parse a button payload string. Returns null if not a journey button.
 */
function parseJourneyButton(rawPayload) {
  if (!rawPayload) return null;
  const s = String(rawPayload).trim();
  const m = s.match(JRN_BUTTON_RE);
  if (m) {
    return {
      format: 'jrn',
      enrollmentId: m[1],
      stepIndex: Number(m[2]),
      action: m[3].toLowerCase(),
    };
  }
  return null;
}

/**
 * Extract raw button payload from a WhatsApp interactive message.
 */
function extractButtonPayload(buttonPayload) {
  if (!buttonPayload) return '';
  if (typeof buttonPayload === 'string') return buttonPayload;
  return String(
    buttonPayload?.interactive?.button_reply?.id ||
    buttonPayload?.interactive?.list_reply?.id ||
    buttonPayload?.button?.payload ||
    buttonPayload?.id ||
    ''
  );
}

/**
 * Main handler.
 *
 * @param {string} clientId
 * @param {string} phone
 * @param {object|string} buttonPayload — WhatsApp interactive message object or raw payload string
 * @returns {Promise<{ claimed: boolean, alreadyHandled?: boolean, action?: string }>}
 */
async function handleJourneyButtonTap(clientId, phone, buttonPayload) {
  if (!clientId || !phone) return { claimed: false };

  const rawPayload = extractButtonPayload(buttonPayload);
  const parsed = parseJourneyButton(rawPayload);

  if (!parsed) {
    // Not a journey button — don't claim
    return { claimed: false };
  }

  const { enrollmentId, stepIndex, action } = parsed;

  // Find the active enrollment
  let sequence;
  try {
    sequence = await FollowUpSequence.findOne({
      _id: mongoose.Types.ObjectId.isValid(enrollmentId) ? new mongoose.Types.ObjectId(enrollmentId) : null,
      clientId,
      status: 'active',
    });
  } catch (err) {
    log.warn(`[JourneyInteractiveRouter] DB lookup failed: ${err.message}`);
    return { claimed: true, error: err.message };
  }

  if (!sequence) {
    log.debug(`[JourneyInteractiveRouter] Enrollment ${enrollmentId} not found or not active`);
    return { claimed: true, alreadyHandled: true };
  }

  const step = sequence.steps?.[stepIndex];
  if (!step) {
    log.debug(`[JourneyInteractiveRouter] Step ${stepIndex} not found in enrollment ${enrollmentId}`);
    return { claimed: true, alreadyHandled: true };
  }

  const clickTs = new Date();
  try {
    const clickPath = `steps.${stepIndex}.clickedAt`;
    const clickTypePath = `steps.${stepIndex}.clickType`;
    const patch = {
      [clickPath]: clickTs,
      [clickTypePath]: 'button',
    };
    if (!step.deliveredAt) {
      patch[`steps.${stepIndex}.deliveredAt`] = clickTs;
    }
    await FollowUpSequence.updateOne({ _id: sequence._id }, { $set: patch });
  } catch (_) {
    /* non-fatal */
  }

  // Idempotency — only handle if step is still awaiting interaction
  const actionableStatuses = ['pending', 'queued', 'sent'];
  const isAwaiting = step.interactionMode === 'awaiting_button' ||
    actionableStatuses.includes(String(step.status));
  if (!isAwaiting || (step.interactionMode !== 'awaiting_button' && step.interactionMode !== 'none' && step.interactionMode)) {
    return { claimed: true, alreadyHandled: true };
  }

  if (action === 'cod_confirm') {
    try {
      const orderId = sequence.sourceOrderId;
      if (orderId) {
        const Client = require('../../models/Client');
        const clientDoc = await Client.findOne({ clientId }).lean();
        if (clientDoc) {
          const { maybeSendCodConfirmationAfterOrderCreate } = require('../../utils/commerce/rtoProtectionService');
          // Mark order as COD confirmed in our system
          const Order = require('../../models/Order');
          await Order.findOneAndUpdate(
            { clientId, shopifyOrderId: orderId },
            { $set: { codConfirmed: true, codConfirmedAt: new Date(), codConfirmedVia: 'journey_button' } }
          ).catch(() => {});
        }
      }
      // Advance the step
      sequence.steps[stepIndex].status = 'completed';
      if (sequence.steps[stepIndex].interactionMode) {
        sequence.steps[stepIndex].interactionMode = 'none';
      }
      await sequence.save();

      // Enqueue next pending step
      const { enqueueDueStepsForSequence } = require('../../utils/messaging/sequenceStepEnqueue');
      await enqueueDueStepsForSequence(sequence).catch(() => {});

      log.info(`[JourneyInteractiveRouter] cod_confirm for enrollment ${enrollmentId}, step ${stepIndex}`);
      return { claimed: true, action: 'cod_confirm', advanced: true };
    } catch (err) {
      log.error(`[JourneyInteractiveRouter] cod_confirm error: ${err.message}`);
      return { claimed: true, error: err.message };
    }
  }

  if (action === 'cod_cancel') {
    try {
      const orderId = sequence.sourceOrderId;
      if (orderId) {
        const Client = require('../../models/Client');
        const clientDoc = await Client.findOne({ clientId }).lean();
        if (clientDoc) {
          const { cancelOrderInShopify } = require('../../utils/commerce/rtoProtectionService');
          await cancelOrderInShopify(clientDoc, orderId).catch((e) =>
            log.warn(`[JourneyInteractiveRouter] cancelOrderInShopify failed: ${e.message}`)
          );
        }
      }
      // Cancel the enrollment
      sequence.status = 'cancelled';
      sequence.cancelledReason = 'cod_cancelled_by_customer';
      sequence.cancelledAt = new Date();
      await sequence.save();

      log.info(`[JourneyInteractiveRouter] cod_cancel for enrollment ${enrollmentId} — order ${orderId}`);
      return { claimed: true, action: 'cod_cancel', cancelled: true };
    } catch (err) {
      log.error(`[JourneyInteractiveRouter] cod_cancel error: ${err.message}`);
      return { claimed: true, error: err.message };
    }
  }

  if (action === 'advance') {
    try {
      sequence.steps[stepIndex].status = 'completed';
      await sequence.save();
      const { enqueueDueStepsForSequence } = require('../../utils/messaging/sequenceStepEnqueue');
      await enqueueDueStepsForSequence(sequence).catch(() => {});
      return { claimed: true, action: 'advance', advanced: true };
    } catch (err) {
      return { claimed: true, error: err.message };
    }
  }

  // Unknown action — still claim to avoid dualBrainEngine processing journey payloads
  log.debug(`[JourneyInteractiveRouter] Unknown action "${action}" for enrollment ${enrollmentId}`);
  return { claimed: true, action, unknown: true };
}

function normalizePhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function findAwaitingTextStepIndex(sequence) {
  const steps = sequence.steps || [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.interactionMode !== 'awaiting_text') continue;
    const st = String(step.status || 'pending');
    if (['sent', 'pending', 'queued', 'processing'].includes(st)) return i;
  }
  return -1;
}

/**
 * Handle inbound text when a journey step awaits free-text (e.g. address verify).
 */
async function handleJourneyTextReply(clientId, phone, textBody) {
  if (!clientId || !phone || !String(textBody || '').trim()) return { claimed: false };

  const digits = normalizePhoneDigits(phone);
  if (digits.length < 8) return { claimed: false };

  const sequences = await FollowUpSequence.find({
    clientId,
    status: 'active',
    sourceFlowId: { $ne: '' },
    phone: { $regex: digits },
  })
    .sort({ updatedAt: -1 })
    .limit(8);

  for (const sequence of sequences) {
    const stepIndex = findAwaitingTextStepIndex(sequence);
    if (stepIndex < 0) continue;

    try {
      const Client = require('../../models/Client');
      const clientDoc = await Client.findOne({ clientId }).lean();
      if (!clientDoc) return { claimed: true, error: 'client_not_found' };

      const { updateOrderShippingAddressFromChat } = require('../../utils/commerce/orderModifyService');
      const convo = {
        metadata: {
          shopify_order_id: sequence.sourceOrderId || '',
          order_number: sequence.sourceOrderId || '',
        },
      };
      const outcome = await updateOrderShippingAddressFromChat({
        client: clientDoc,
        convo,
        phone,
        addressText: String(textBody).trim(),
      });

      sequence.steps[stepIndex].status = 'completed';
      sequence.steps[stepIndex].interactionMode = 'none';
      await sequence.save();

      const { enqueueDueStepsForSequence } = require('../../utils/messaging/sequenceStepEnqueue');
      await enqueueDueStepsForSequence(sequence).catch(() => {});

      log.info(
        `[JourneyInteractiveRouter] address text for enrollment ${sequence._id}, step ${stepIndex} (ok=${outcome.ok})`
      );
      return { claimed: true, action: 'address_text', ok: outcome.ok, reason: outcome.reason };
    } catch (err) {
      log.error(`[JourneyInteractiveRouter] address text error: ${err.message}`);
      return { claimed: true, error: err.message };
    }
  }

  return { claimed: false };
}

module.exports = {
  handleJourneyButtonTap,
  handleJourneyTextReply,
  parseJourneyButton,
  findAwaitingTextStepIndex,
};
