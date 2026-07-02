'use strict';

const Message = require('../../models/Message');
const Order = require('../../models/Order');
const { normalizePhone } = require('../core/helpers');

function lastSentStepIndex(steps = []) {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i]?.status === 'sent' && steps[i]?.sentAt) return i;
  }
  return -1;
}

async function loadOrderForSequence(clientId, sequence) {
  const orderId = String(sequence?.sourceOrderId || '').trim();
  if (!clientId || !orderId) return null;
  return Order.findOne({
    clientId,
    $or: [{ orderId }, { shopifyOrderId: orderId }],
  })
    .select('orderId paymentMethod isCOD totalPrice lineItems shopifyCustomerId')
    .lean();
}

function isCodOrder(order) {
  if (!order) return false;
  if (order.isCOD === true) return true;
  const pm = String(order.paymentMethod || '').toLowerCase();
  return pm.includes('cod') || pm.includes('cash_on_delivery') || pm.includes('cash on delivery');
}

/**
 * Evaluate optional step.condition before dispatch.
 * Supported: replied / no_reply; cod_order / prepaid_order; order_value_gt_1000;
 * specific_product:id1,id2; first_time_customer / returning_customer.
 */
async function evaluatePositiveCondition({ clientId, phone, condition, sequence }) {

  const phoneNorm = normalizePhone(phone);

  if (['replied', 'if_replied', 'require_reply', 'no_reply', 'if_no_reply', 'skip_if_replied'].includes(condition)) {
    if (!clientId || !phoneNorm) return { proceed: true };
    const steps = sequence?.steps || [];
    const lastSentIdx = lastSentStepIndex(steps);
    const since =
      lastSentIdx >= 0
        ? new Date(steps[lastSentIdx].sentAt)
        : sequence?.createdAt
          ? new Date(sequence.createdAt)
          : new Date(0);

    const inboundCount = await Message.countDocuments({
      clientId,
      phone: phoneNorm,
      direction: 'inbound',
      createdAt: { $gte: since },
    });

    if (['replied', 'if_replied', 'require_reply'].includes(condition)) {
      return { proceed: inboundCount > 0, reason: inboundCount > 0 ? null : 'condition_require_reply' };
    }
    if (['no_reply', 'if_no_reply', 'skip_if_replied'].includes(condition)) {
      return { proceed: inboundCount === 0, reason: inboundCount === 0 ? null : 'condition_no_reply' };
    }
  }

  if (condition.startsWith('specific_product')) {
    const order = await loadOrderForSequence(clientId, sequence);
    if (!order) return { proceed: true };
    const idsPart = condition.includes(':') ? condition.split(':')[1] : '';
    const wanted = idsPart.split(',').map((s) => s.trim()).filter(Boolean);
    if (!wanted.length) return { proceed: true };
    const lineIds = (order.lineItems || []).map((li) =>
      String(li.product_id || li.productId || li.variant_id || li.variantId || '')
    );
    const hit = wanted.some((id) => lineIds.includes(id));
    return { proceed: hit, reason: hit ? null : 'condition_product_mismatch' };
  }

  if (
    ['cod_order', 'prepaid_order', 'order_value_gt_1000', 'first_time_customer', 'returning_customer'].includes(
      condition
    )
  ) {
    const order = await loadOrderForSequence(clientId, sequence);
    if (!order) return { proceed: true };

    if (condition === 'cod_order') {
      const ok = isCodOrder(order);
      return { proceed: ok, reason: ok ? null : 'condition_not_cod' };
    }
    if (condition === 'prepaid_order') {
      const ok = !isCodOrder(order);
      return { proceed: ok, reason: ok ? null : 'condition_not_prepaid' };
    }
    if (condition === 'order_value_gt_1000') {
      const total = Number(order.totalPrice || 0);
      const ok = total > 1000;
      return { proceed: ok, reason: ok ? null : 'condition_order_value_low' };
    }
    if (condition === 'first_time_customer' || condition === 'returning_customer') {
      const customerKey = String(order.shopifyCustomerId || '').trim();
      if (!customerKey) return { proceed: true };
      const priorCount = await Order.countDocuments({
        clientId,
        shopifyCustomerId: customerKey,
        orderId: { $ne: order.orderId },
      });
      const isFirst = priorCount === 0;
      if (condition === 'first_time_customer') {
        return { proceed: isFirst, reason: isFirst ? null : 'condition_not_first_time' };
      }
      return { proceed: !isFirst, reason: !isFirst ? null : 'condition_not_returning' };
    }
  }

  return { proceed: true };
}

function normalizeCondition(raw = '') {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_');
}

/**
 * Evaluate optional step.condition before dispatch.
 * Supports positive gates and `not_*` negated gates for dual-path branch compile.
 */
async function evaluateSequenceStepCondition({ clientId, phone, step, sequence }) {
  const condition = normalizeCondition(step?.condition);
  if (!condition) return { proceed: true };

  const { evaluateCodPrepaidOutcomeCondition } = require('../services/journeyBuilder/codToPrepaid/codToPrepaidJourneyAdvance');
  const codOutcome = evaluateCodPrepaidOutcomeCondition(sequence, condition);
  if (codOutcome) return codOutcome;

  const isNegated = condition.startsWith('not_');
  const innerCondition = isNegated ? condition.slice(4) : condition;
  const result = await evaluatePositiveCondition({
    clientId,
    phone,
    condition: innerCondition,
    sequence,
  });

  if (!isNegated) return result;

  const proceed = !result.proceed;
  return {
    proceed,
    reason: proceed ? null : `negated_${result.reason || 'condition_not_met'}`,
  };
}

module.exports = { evaluateSequenceStepCondition, evaluatePositiveCondition, lastSentStepIndex };
