const Client = require('../../models/Client');
const { scheduleOutboundMessage } = require('./scheduleOutboundMessage');
const FollowUpSequence = require('../../models/FollowUpSequence');
const sequenceTemplates = require('../../data/sequenceTemplates');
const WhatsApp = require('../meta/whatsapp');
const log = require('../core/logger')('CommerceAutomation');

const COMMERCE_AUTOMATION_VERSION = 1;
const ORDER_STATUS_EVENTS = ['paid', 'shipped', 'delivered', 'cancelled'];

function normalizeEvent(eventName) {
  const e = String(eventName || '').toLowerCase();
  if (e === 'fulfilled') return 'shipped';
  if (e === 'refunded') return 'cancelled';
  return e;
}

function normalizeSkuRule(rule = {}) {
  const mt = String(rule.matchType || 'exact').toLowerCase();
  const matchType =
    mt === 'contains' ? 'contains' : mt === 'starts_with' || mt === 'startsWith' ? 'starts_with' : 'exact';
  return {
    id: rule.id || `sku_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: rule.description || `SKU ${rule.sku || 'Rule'}`,
    triggerType: 'sku_event',
    event: normalizeEvent(rule.triggerEvent || 'paid'),
    matchType,
    sku: String(rule.sku || '').trim(),
    actionType: rule.actionType === 'sequence' ? 'enroll_sequence' : (Number(rule.delayMinutes || 0) > 0 ? 'delay_then_send' : 'send_template'),
    templateName: rule.templateName || '',
    sequenceId: rule.sequenceId || '',
    language: rule.language || 'en',
    delayMinutes: Number(rule.delayMinutes || 0),
    imageUrl: rule.imageUrl || '',
    isActive: rule.isActive !== false,
    meta: {
      source: 'legacy_sku_automation',
      legacyDescription: rule.description || '',
    },
  };
}

function normalizeStatusMappings(nicheData = {}) {
  const map = nicheData.orderStatusTemplates || {};
  return ORDER_STATUS_EVENTS
    .filter((status) => !!map[status])
    .map((status) => ({
      id: `status_${status}`,
      name: `Order ${status} message`,
      triggerType: 'order_status',
      event: status,
      actionType: 'send_template',
      templateName: map[status],
      language: 'en_US',
      delayMinutes: 0,
      isActive: true,
      matchType: 'exact',
      sku: '',
      meta: { source: 'legacy_order_status_map' },
    }));
}

function buildLegacySnapshot(client = {}) {
  return {
    capturedAt: new Date(),
    skuAutomations: Array.isArray(client.skuAutomations) ? client.skuAutomations : [],
    orderStatusTemplates: client.nicheData?.orderStatusTemplates || {},
  };
}

function normalizeAutomationMappings(raw) {
  if (!raw || typeof raw !== 'object') return { body: {} };
  const body = raw.body && typeof raw.body === 'object' ? raw.body : raw;
  const out = {};
  Object.entries(body || {}).forEach(([k, v]) => {
    if (v != null && v !== '') out[String(k)] = String(v);
  });
  return { body: out };
}

function mergeTemplateMappings(templateMappings = {}, automationMappings = {}) {
  const tplBody = templateMappings?.body || templateMappings || {};
  const autoBody = automationMappings?.body || automationMappings || {};
  return {
    body: { ...tplBody, ...autoBody },
  };
}

function inferBodyVariables(automation, order, item) {
  const customerName = order.customerName || 'Customer';
  const orderNumber = order.orderNumber || order.orderId || '';
  if (automation.triggerType === 'order_status') {
    const statusLabel = automation.event === 'shipped' ? 'Shipped' : automation.event;
    return [customerName, orderNumber, statusLabel];
  }
  return [customerName, item?.name || automation.sku || 'Product', orderNumber];
}

async function scheduleAutomationMessage({ clientConfig, order, automation, item }) {
  const phone = order.customerPhone || order.phone;
  if (!phone) return;
  const sendAt = new Date(Date.now() + (Number(automation.delayMinutes || 0) * 60 * 1000));
  await scheduleOutboundMessage({
    clientId: clientConfig.clientId,
    phone,
    templateName: automation.templateName,
    variables: inferBodyVariables(automation, order, item),
    headerImage: automation.imageUrl || '',
    languageCode: automation.language || 'en_US',
    sendAt,
    sourceType: 'commerce_automation',
    sourceId: automation.id || `commerce_${automation.event}`,
    metadata: {
      source: 'commerce_automation',
      automationId: automation.id,
      event: automation.event,
      sku: automation.sku || '',
      variableMappings: automation.variableMappings || { body: {} },
      customVariableValues: automation.customVariableValues || {},
    },
  });
}

async function enrollSequence({ clientConfig, order, automation }) {
  const phone = order.customerPhone || order.phone;
  if (!phone || !automation.sequenceId) return;
  const seqData = sequenceTemplates.find((s) => s.id === automation.sequenceId);
  if (!seqData) return;
  const { ensureLeadForSequence } = require('../messaging/ensureLeadForSequence');
  const lead = await ensureLeadForSequence({
    clientId: clientConfig.clientId,
    phone,
    source: 'commerce_automation',
  });
  const mappedSteps = (seqData.steps || []).map((s) => ({
    type: s.type || 'whatsapp',
    templateName: s.templateName,
    content: s.content,
    delayValue: s.delayValue,
    delayUnit: s.delayUnit,
    sendAt: new Date(Date.now() + (Number(s.delayValue || 0) * 60000)),
    status: 'pending',
  }));
  await FollowUpSequence.create({
    clientId: clientConfig.clientId,
    leadId: lead._id,
    phone: lead.phoneNumber,
    email: lead.email,
    name: seqData.name,
    steps: mappedSteps,
    status: 'active',
    metadata: {
      source: 'commerce_automation',
      automationId: automation.id,
      sku: automation.sku || '',
    },
  });
}

async function sendAutomationTemplate({ clientConfig, order, automation, item }) {
  const phone = order.customerPhone || order.phone;
  if (!phone || !automation.templateName) return false;

  const triggerMap = {
    paid: 'order_placed',
    shipped: 'order_fulfilled',
    delivered: 'order_delivered',
    cancelled: 'order_cancelled',
  };
  const trigger = triggerMap[automation.event] || null;

  try {
    const { sendForAutomation } = require('../../services/templateSender');
    const mergedMappings = mergeTemplateMappings(null, automation.variableMappings);

    const result = await sendForAutomation({
      clientId: clientConfig.clientId,
      phone,
      metaName: automation.templateName,
      contextType: 'order',
      trigger,
      variableMappings: mergedMappings || undefined,
      contextData: {
        order: {
          name: order.orderNumber || order.orderId,
          orderNumber: order.orderNumber || order.orderId,
          orderId: order.orderId,
          customer: {
            first_name: (order.customerName || 'Customer').split(' ')[0],
            name: order.customerName,
          },
          customerName: order.customerName,
          line_items: (order.items || []).map((i) => ({
            title: i.name,
            name: i.name,
            sku: i.sku,
            image: i.image ? { src: i.image } : undefined,
          })),
          total_price: order.amount || order.totalPrice,
          totalPrice: order.totalPrice,
          payment_method: order.paymentMethod || (order.isCOD ? 'Cash on Delivery' : 'Prepaid'),
          isCOD: order.isCOD,
          shipping_address: order.shippingAddress,
          fulfillments: order.trackingUrl ? [{ tracking_url: order.trackingUrl }] : [],
          phone: order.customerPhone,
        },
        extra: {
          item,
          customVariableValues: automation.customVariableValues || {},
        },
      },
      channel: 'whatsapp',
    });

    if (result?.whatsapp?.sent) return true;
    log.warn(
      `[CommerceAutomation] Rule ${automation.id} not sent: ${result?.failureCode || result?.whatsapp?.reason}`
    );
  } catch (err) {
    log.warn(`[CommerceAutomation] sendForAutomation failed: ${err.message}`);
  }

  return false;
}

async function runAutomationAction({ clientConfig, order, automation, item }) {
  if (automation.actionType === 'enroll_sequence') {
    await enrollSequence({ clientConfig, order, automation });
    return;
  }
  if (automation.actionType === 'delay_then_send' && Number(automation.delayMinutes || 0) > 0) {
    await scheduleAutomationMessage({ clientConfig, order, automation, item });
    return;
  }
  await sendAutomationTemplate({ clientConfig, order, automation, item });
}

function matchesSkuRule(automation, item) {
  const target = String(automation.sku || '').trim().toLowerCase();
  const sku = String(item?.sku || '').trim().toLowerCase();
  if (!target || !sku) return false;
  if (automation.matchType === 'contains') return sku.includes(target);
  if (automation.matchType === 'starts_with') return sku.startsWith(target);
  return sku === target;
}

function isTemplateApprovedForClient(clientConfig, templateName) {
  if (!templateName) return false;
  const synced = (clientConfig.syncedMetaTemplates || []).find((t) => t.name === templateName);
  if (synced && String(synced.status || '').toUpperCase() === 'APPROVED') return true;
  return false;
}

function buildUnifiedFromLegacy(clientConfig = {}) {
  const skuAutomations = Array.isArray(clientConfig.skuAutomations) ? clientConfig.skuAutomations.map(normalizeSkuRule) : [];
  const statusAutomations = normalizeStatusMappings(clientConfig.nicheData || {});
  const merged = [...statusAutomations, ...skuAutomations];
  const deduped = [];
  const seen = new Set();
  for (const rule of merged) {
    const k = `${rule.triggerType}:${rule.event}:${rule.sku || ''}:${rule.templateName || ''}:${rule.sequenceId || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(rule);
  }
  return deduped;
}

async function ensureMigration(clientConfig = {}, { persist = true } = {}) {
  if (Array.isArray(clientConfig.commerceAutomations) && clientConfig.commerceAutomations.length > 0) {
    return clientConfig.commerceAutomations;
  }
  const unified = buildUnifiedFromLegacy(clientConfig);
  if (persist && clientConfig.clientId) {
    await Client.findOneAndUpdate(
      { clientId: clientConfig.clientId },
      {
        $set: {
          commerceAutomations: unified,
          commerceAutomationVersion: COMMERCE_AUTOMATION_VERSION,
          commerceAutomationMigratedAt: new Date(),
          commerceAutomationLegacySnapshot: buildLegacySnapshot(clientConfig),
        },
      },
      { new: false }
    );
  }
  return unified;
}

async function listAutomations(clientConfig = {}) {
  if (Array.isArray(clientConfig.commerceAutomations) && clientConfig.commerceAutomations.length > 0) {
    return clientConfig.commerceAutomations;
  }
  const unified = buildUnifiedFromLegacy(clientConfig);
  if (clientConfig.clientId && unified.length > 0) {
    setImmediate(() => {
      Client.findOneAndUpdate(
        { clientId: clientConfig.clientId },
        {
          $set: {
            commerceAutomations: unified,
            commerceAutomationVersion: COMMERCE_AUTOMATION_VERSION,
            commerceAutomationMigratedAt: new Date(),
            commerceAutomationLegacySnapshot: buildLegacySnapshot(clientConfig),
          },
        }
      ).catch(() => {});
    });
  }
  return unified;
}

async function upsertAutomation(clientId, automation = {}) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error('Client not found');
  const current = await ensureMigration(client, { persist: false });
  const normalized = {
    id: automation.id || `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: automation.name || 'Automation rule',
    triggerType: automation.triggerType || 'sku_event',
    event: normalizeEvent(automation.event || 'paid'),
    matchType:
      automation.matchType === 'contains'
        ? 'contains'
        : automation.matchType === 'starts_with'
          ? 'starts_with'
          : 'exact',
    sku: String(automation.sku || '').trim(),
    actionType: automation.actionType || 'send_template',
    templateName: automation.templateName || '',
    sequenceId: automation.sequenceId || '',
    language: automation.language || 'en',
    delayMinutes: Number(automation.delayMinutes || 0),
    imageUrl: automation.imageUrl || '',
    isActive: automation.isActive !== false,
    variableMappings: normalizeAutomationMappings(automation.variableMappings),
    customVariableValues: automation.customVariableValues || {},
    meta: automation.meta || {},
  };

  const idx = current.findIndex((a) => a.id === normalized.id);
  if (idx >= 0) current[idx] = { ...current[idx], ...normalized };
  else current.push(normalized);

  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: {
        commerceAutomations: current,
        commerceAutomationVersion: COMMERCE_AUTOMATION_VERSION,
      },
    }
  );
  return normalized;
}

async function deleteAutomation(clientId, automationId) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error('Client not found');
  const current = await ensureMigration(client, { persist: false });
  const updated = current.filter((a) => a.id !== automationId);
  await Client.findOneAndUpdate(
    { clientId },
    { $set: { commerceAutomations: updated, commerceAutomationVersion: COMMERCE_AUTOMATION_VERSION } }
  );
  return updated;
}

function getOrderStatusTemplateMap(automations = []) {
  const map = {};
  for (const a of automations) {
    if (a.triggerType === 'order_status' && a.isActive && a.templateName) {
      map[normalizeEvent(a.event)] = a.templateName;
    }
  }
  return map;
}

/**
 * Keep commerceAutomations in sync when nicheData.orderStatusTemplates changes.
 */
async function syncOrderStatusFromNicheMap(clientId, templatesMap = {}) {
  const {
    sanitizeOrderStatusTemplates,
    ORDER_STATUS_ECO_REGISTRY,
  } = require('./orderStatusTemplatePolicy');

  const client = await Client.findOne({ clientId });
  if (!client) throw new Error('Client not found');

  const sanitized = sanitizeOrderStatusTemplates(templatesMap);
  let automations = await ensureMigration(client, { persist: false });

  const statusKeys = ['paid', 'shipped', 'delivered', 'cancelled'];

  for (const status of statusKeys) {
    const templateName = sanitized[status];
    const preset = ORDER_STATUS_ECO_REGISTRY[status];
    const idx = automations.findIndex(
      (a) => a.triggerType === 'order_status' && normalizeEvent(a.event) === status
    );

    if (!templateName) {
      if (idx >= 0) {
        automations[idx] = { ...automations[idx], isActive: false, templateName: '' };
      }
      continue;
    }

    const row = {
      id: idx >= 0 ? automations[idx].id : `status_${status}`,
      name: preset?.label || `Order ${status} message`,
      triggerType: 'order_status',
      event: status,
      matchType: 'exact',
      sku: '',
      actionType: 'send_template',
      templateName,
      sequenceId: '',
      language: 'en',
      delayMinutes: 0,
      imageUrl: '',
      isActive: true,
      variableMappings: preset?.variableMappings || { body: {} },
      customVariableValues: {},
      meta: { source: 'order_status_templates_sync' },
    };

    if (idx >= 0) automations[idx] = { ...automations[idx], ...row };
    else automations.push(row);
  }

  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: {
        'nicheData.orderStatusTemplates': sanitized,
        commerceAutomations: automations,
        commerceAutomationVersion: COMMERCE_AUTOMATION_VERSION,
      },
    }
  );

  return { sanitized, automations };
}

async function runAutomationsForEvent({ clientConfig, eventType, order, options = {} }) {
  const { skipOrderStatusRules = false } = options;
  const automations = await ensureMigration(clientConfig, { persist: true });
  const normalizedEvent = normalizeEvent(eventType);
  const active = automations.filter((a) => a.isActive && normalizeEvent(a.event) === normalizedEvent);
  if (!active.length) return { matched: 0 };

  let matched = 0;
  for (const automation of active) {
    try {
      if (automation.triggerType === 'order_status') {
        if (skipOrderStatusRules) continue;
        await runAutomationAction({ clientConfig, order, automation, item: null });
        matched += 1;
        continue;
      }
      if (automation.triggerType === 'sku_event') {
        for (const item of order.items || []) {
          if (!matchesSkuRule(automation, item)) continue;
          await runAutomationAction({ clientConfig, order, automation, item });
          matched += 1;
        }
      }
    } catch (err) {
      log.error(`Automation ${automation.id} failed: ${err.message}`);
    }
  }
  return { matched };
}

function simulateAutomation({ automation, order }) {
  const event = normalizeEvent(order?.event || automation?.event || 'paid');
  const normalized = {
    ...automation,
    triggerType: automation?.triggerType || 'sku_event',
    event: normalizeEvent(automation?.event || 'paid'),
    matchType: automation?.matchType || 'exact',
    sku: String(automation?.sku || ''),
  };
  if (normalized.triggerType === 'order_status') {
    return { matched: normalizeEvent(normalized.event) === event, reason: 'order_status_event_check' };
  }
  const items = Array.isArray(order?.items) ? order.items : [];
  const item = items.find((i) => matchesSkuRule(normalized, i));
  return { matched: !!item && normalizeEvent(normalized.event) === event, reason: item ? `matched_${item.sku}` : 'no_sku_match' };
}

module.exports = {
  COMMERCE_AUTOMATION_VERSION,
  normalizeEvent,
  ensureMigration,
  listAutomations,
  upsertAutomation,
  deleteAutomation,
  getOrderStatusTemplateMap,
  syncOrderStatusFromNicheMap,
  runAutomationsForEvent,
  simulateAutomation,
};
