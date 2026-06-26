'use strict';

const AdLead = require('../../models/AdLead');
const WhatsAppFlow = require('../../models/WhatsAppFlow');
const FollowUpSequence = require('../../models/FollowUpSequence');
const log = require('../../utils/core/logger')('PostPurchaseEnroll');

const TRIGGER_MAP = {
  'orders/create': 'order_placed',
  'orders/fulfilled': 'order_fulfilled',
  'orders/updated': null,
};

const { pickCanonicalPhone } = require('../../utils/core/phoneSanitizer');
const { sanitizePhoneForStorage } = require('../../utils/core/phoneE164Policy');

function normalizePhone(data) {
  const phoneCandidates = [
    data.phone,
    data.customer?.phone,
    data.billing_address?.phone,
    data.shipping_address?.phone,
  ];
  const canonical = pickCanonicalPhone(phoneCandidates, { country: 'IN' });
  return canonical ? sanitizePhoneForStorage(canonical) : '';
}

function policyAllows(flow, lead, orderAmount) {
  const p = flow.journeyPolicies || {};
  if (p.minOrderValue != null && orderAmount < p.minOrderValue) return false;
  return true;
}

async function hasActivePlaybookEnrollment({ clientId, leadId, playbookKey }) {
  const existing = await FollowUpSequence.findOne({
    clientId,
    leadId,
    playbookKey,
    status: 'active',
    type: 'post_purchase_journey',
  }).lean();
  return !!existing;
}

async function repeatWindowOk(flow, leadId, clientId) {
  const repeat = flow.journeyPolicies?.repeatPerCustomer || 'never';
  if (repeat === 'never') {
    const prior = await FollowUpSequence.findOne({
      clientId,
      leadId,
      playbookKey: flow.playbookKey,
      type: 'post_purchase_journey',
      status: { $in: ['active', 'completed'] },
    }).lean();
    return !prior;
  }
  const since = new Date();
  if (repeat === 'once_per_month') since.setDate(since.getDate() - 30);
  if (repeat === 'once_per_year') since.setFullYear(since.getFullYear() - 1);
  const recent = await FollowUpSequence.findOne({
    clientId,
    leadId,
    playbookKey: flow.playbookKey,
    type: 'post_purchase_journey',
    createdAt: { $gte: since },
  }).lean();
  return !recent;
}

function computeFirstSendAt({ windowDays, optimalHour, tenantTzOffsetMin = 330 }) {
  const base = new Date();
  base.setDate(base.getDate() + (windowDays || 0));
  if (optimalHour != null && optimalHour >= 0 && optimalHour <= 23) {
    const send = new Date(base);
    send.setUTCHours(optimalHour - Math.floor(tenantTzOffsetMin / 60), 0, 0, 0);
    if (send <= new Date()) send.setDate(send.getDate() + 1);
    return send;
  }
  return base;
}

function buildStepsFromFlow(flow, sendAt) {
  const tpl = flow.nodes?.[0]?.data || {};
  return [
    {
      type: 'whatsapp',
      templateName: tpl.templateName || 'utility_message',
      content: tpl.body || '',
      sendAt,
      status: 'pending',
      delayValue: flow.journeyPolicies?.windowDays || 0,
      delayUnit: 'd',
    },
  ];
}

async function enrollLeadInPlaybook({
  client,
  flow,
  lead,
  orderPayload = {},
  storeKey = '',
}) {
  if (flow.status !== 'PUBLISHED') return { enrolled: false, reason: 'not_published' };

  const orderAmount = parseFloat(orderPayload.total_price || orderPayload.amount || 0);
  if (!policyAllows(flow, lead, orderAmount)) return { enrolled: false, reason: 'policy' };

  const okRepeat = await repeatWindowOk(flow, lead._id, client.clientId);
  if (!okRepeat) return { enrolled: false, reason: 'repeat_window' };

  const active = await hasActivePlaybookEnrollment({
    clientId: client.clientId,
    leadId: lead._id,
    playbookKey: flow.playbookKey,
  });
  if (active) return { enrolled: false, reason: 'already_active' };

  const sendAt = computeFirstSendAt({
    windowDays: flow.journeyPolicies?.windowDays ?? 1,
    optimalHour: lead.optimalSendHour,
  });

  const seq = await FollowUpSequence.create({
    clientId: client.clientId,
    leadId: lead._id,
    phone: lead.phoneNumber,
    name: flow.name,
    type: 'post_purchase_journey',
    playbookKey: flow.playbookKey,
    sourceOrderId: String(orderPayload.id || orderPayload.name || ''),
    sourceFlowId: flow.flowId,
    status: 'active',
    steps: buildStepsFromFlow(flow, sendAt),
    enrollment: { mode: 'instant', blueprint: { storeKey, orderId: orderPayload.id } },
  });

  return { enrolled: true, sequenceId: seq._id };
}

async function enrollFromOrderEvent({ client, orderPayload, shopifyTopic, storeKey = '' }) {
  const triggers = [];
  const mapped = TRIGGER_MAP[shopifyTopic];
  if (mapped) triggers.push(mapped);
  if (shopifyTopic === 'orders/fulfilled') triggers.push('order_delivered');
  if (!triggers.length) return { enrolled: 0 };

  const phone = normalizePhone(orderPayload);
  if (!phone) return { enrolled: 0 };

  let lead = await AdLead.findOne({ clientId: client.clientId, phoneNumber: phone });
  if (!lead) {
    lead = await AdLead.create({
      clientId: client.clientId,
      phoneNumber: phone,
      name: orderPayload.customer?.first_name || 'Customer',
      source: 'shopify_order',
    });
  }

  let enrolled = 0;
  for (const trigger of [...new Set(triggers)]) {
    const flows = await WhatsAppFlow.find({
      clientId: client.clientId,
      flowType: 'post_purchase_journey',
      journeyTrigger: trigger,
      status: 'PUBLISHED',
    }).lean();

    for (const flow of flows) {
      const r = await enrollLeadInPlaybook({ client, flow, lead, orderPayload, storeKey });
      if (r.enrolled) enrolled += 1;
    }
  }
  return { enrolled };
}

async function enrollWinBackForLead({ client, lead, flow }) {
  return enrollLeadInPlaybook({
    client,
    flow,
    lead,
    orderPayload: { total_price: 0 },
  });
}

function schedulePostPurchaseEnrollment({ client, orderPayload, shopifyTopic, storeKey }) {
  setImmediate(() => {
    enrollFromOrderEvent({ client, orderPayload, shopifyTopic, storeKey }).catch((e) =>
      log.warn(`Enrollment async failed: ${e.message}`)
    );
  });
}

module.exports = {
  enrollFromOrderEvent,
  enrollWinBackForLead,
  schedulePostPurchaseEnrollment,
  enrollLeadInPlaybook,
};
