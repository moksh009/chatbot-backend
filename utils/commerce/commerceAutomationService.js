const Client = require('../../models/Client');
const { scheduleOutboundMessage } = require('./scheduleOutboundMessage');
const FollowUpSequence = require('../../models/FollowUpSequence');
const sequenceTemplates = require('../../data/sequenceTemplates');
const WhatsApp = require('../meta/whatsapp');
const log = require('../core/logger')('CommerceAutomation');
const { isMongoTransientError, withMongoRetry } = require('../core/mongoRetry');
const {
  mergeSystemAutomations,
  isSystemAutomation,
  validateCartFollowupDelay,
  cartFollowupSyncPatch,
  CART_FOLLOWUP_MIN_MINUTES,
} = require('./commerceAutomationPresets');

const COMMERCE_AUTOMATION_VERSION = 3;
const ORDER_STATUS_EVENTS = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

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
  const bodySource = raw.body && typeof raw.body === 'object' ? raw.body : raw;
  const body = {};
  Object.entries(bodySource || {}).forEach(([k, v]) => {
    if (/^\d+$/.test(String(k)) && v != null && v !== '') body[String(k)] = String(v);
  });
  const out = { body };
  const headerKey = raw.header || raw.headerVariable;
  if (headerKey) out.header = String(headerKey);
  if (raw.buttons && typeof raw.buttons === 'object') {
    const buttons = {};
    Object.entries(raw.buttons).forEach(([k, v]) => {
      if (v != null && v !== '') buttons[String(k)] = String(v);
    });
    if (Object.keys(buttons).length) out.buttons = buttons;
  }
  return out;
}

/**
 * Default body mappings for the 3 official eco order-status templates plus
 * the abandoned cart winback. Mirrors `utils/commerce/orderStatusTemplatePolicy`
 * and frontend `config/automationSlotCatalog`. Used to auto-seed mappings on
 * rule save so merchants never have to wire `{{1}}…{{n}}` by hand when they
 * pick the recommended Shopify pack template.
 */
const ECO_TEMPLATE_BODY_MAPPINGS = {
  eco_order_confirmed: { 1: 'first_name', 2: 'order_id', 3: 'order_items', 4: 'payment_method' },
  order_confirmation_v1: {
    1: 'first_name',
    2: 'order_id',
    3: 'order_items',
    4: 'order_total',
    5: 'shipping_address',
  },
  eco_shipping_update: { 1: 'first_name', 2: 'order_id', 3: 'tracking_url' },
  eco_delivered: { 1: 'first_name', 2: 'order_id' },
  /** Delivery tracking prebuilts (routes/templateGate.js blueprints). */
  order_in_transit: { 1: 'first_name', 2: 'order_id', 3: 'tracking_url' },
  order_out_for_delivery: { 1: 'first_name', 2: 'order_id' },
  order_delivered_update: { 1: 'first_name', 2: 'order_id' },
  delivery_attempt_failed: { 1: 'first_name', 2: 'order_id' },
  rto_ndr_rescue: { 1: 'first_name', 2: 'order_id', 3: 'tracking_url' },
};

function seedEcoBodyMappings(templateName, mappings) {
  const tplName = String(templateName || '');
  const eco = ECO_TEMPLATE_BODY_MAPPINGS[tplName];
  if (!eco) return mappings;
  const current = mappings?.body && typeof mappings.body === 'object' ? mappings.body : {};
  const merged = { ...current };
  let touched = false;
  for (const [pos, field] of Object.entries(eco)) {
    if (!merged[pos] || merged[pos] === '') {
      merged[pos] = field;
      touched = true;
    }
  }
  if (tplName === 'eco_order_confirmed' && merged['3'] === 'order_total') {
    merged['3'] = 'order_items';
    touched = true;
  }
  if (!touched) return mappings;
  return { ...(mappings || {}), body: merged };
}

function mergeTemplateMappings(templateMappings = {}, automationMappings = {}) {
  const tpl = templateMappings && typeof templateMappings === 'object' ? templateMappings : {};
  const auto = automationMappings && typeof automationMappings === 'object' ? automationMappings : {};
  const tplBody = tpl.body || tpl;
  const autoBody = auto.body || auto;
  const merged = {
    body: { ...tplBody, ...autoBody },
  };
  const header = auto.header || auto.headerVariable || tpl.header || tpl.headerVariable;
  if (header) merged.header = String(header);
  const buttons = { ...(tpl.buttons || {}), ...(auto.buttons || {}) };
  if (Object.keys(buttons).length) merged.buttons = buttons;
  return merged;
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
  const { mapStepsWithCumulativeSendAt } = require('../messaging/sequenceDelayUtils');
  const { enqueueDueStepsForSequence } = require('../messaging/sequenceStepEnqueue');
  const lead = await ensureLeadForSequence({
    clientId: clientConfig.clientId,
    phone,
    source: 'commerce_automation',
  });
  const scheduled = mapStepsWithCumulativeSendAt(seqData.steps || []);
  const mappedSteps = scheduled.map((s) => ({
    type: s.type || 'whatsapp',
    templateName: s.templateName,
    content: s.content,
    delayValue: s.delayValue,
    delayUnit: s.delayUnit,
    sendAt: s.sendAt,
    status: 'pending',
  }));
  const sequence = await FollowUpSequence.create({
    clientId: clientConfig.clientId,
    leadId: lead._id,
    phone: lead.phoneNumber,
    email: lead.email,
    name: seqData.name,
    steps: mappedSteps,
    status: 'active',
    cancelOnReply: seqData.cancelOnReply !== false,
    metadata: {
      source: 'commerce_automation',
      automationId: automation.id,
      sku: automation.sku || '',
    },
  });
  await enqueueDueStepsForSequence(sequence).catch(() => {});
}

async function sendAutomationTemplate({ clientConfig, order, automation, item }) {
  const phone = order.customerPhone || order.phone;
  if (!phone || !automation.templateName) return false;

  const triggerMap = {
    pending: 'order_placed',
    paid: 'order_placed',
    shipped: 'order_fulfilled',
    delivered: 'order_delivered',
    cancelled: 'order_cancelled',
    cod: 'cod_order_placed',
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

function normalizeProductId(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  const m = s.match(/(\d+)$/);
  return m ? m[1] : s;
}

function resolveTargetProductIds(automation = {}) {
  const fromArray = Array.isArray(automation.targetProductIds)
    ? automation.targetProductIds.map(normalizeProductId).filter(Boolean)
    : [];
  if (fromArray.length) return [...new Set(fromArray)];
  const legacy = normalizeProductId(automation.productId);
  return legacy ? [legacy] : [];
}

function hasSpecificProductScope(automation = {}) {
  if (String(automation.triggerScope || '').toLowerCase() === 'specific_product') return true;
  return resolveTargetProductIds(automation).length > 0;
}

function matchesProductFilter(automation, order) {
  const targetIds = resolveTargetProductIds(automation);
  if (!targetIds.length) return true;
  const items = order.items || [];
  const orderProductIds = new Set(
    items
      .map((item) => normalizeProductId(item.productId || item.shopifyProductId))
      .filter(Boolean)
  );
  if (targetIds.some((tid) => orderProductIds.has(tid))) return true;
  if (automation.sku) {
    return items.some((item) => matchesSkuRule({ ...automation, productId: '' }, item));
  }
  return false;
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

function syncSystemOrderRulesFromNicheMap(automations = [], nicheData = {}) {
  const map = nicheData?.orderStatusTemplates || {};
  if (!map || typeof map !== 'object') return automations;

  const nicheKeysForRule = (rule) => {
    const event = normalizeEvent(rule.event);
    const keys = [event];
    if (event === 'unfulfilled') keys.push('paid', 'pending');
    if (event === 'in_transit') keys.push('shipped', 'fulfilled');
    if (event === 'delivered') keys.push('delivered');
    return keys;
  };

  return (automations || []).map((rule) => {
    if (rule?.meta?.category !== 'order_notification') return rule;
    let mappedTemplate = '';
    for (const key of nicheKeysForRule(rule)) {
      const tpl = String(map[key] || '').trim();
      if (tpl) {
        mappedTemplate = tpl;
        break;
      }
    }
    if (!mappedTemplate) return rule;
    if (String(rule.templateName || '').trim()) return rule;
    return {
      ...rule,
      templateName: mappedTemplate,
      isActive: true,
    };
  });
}

const CART_SLOT_TEMPLATE_NAMES = {
  followup_1: 'cart_recovery_1',
  followup_2: 'cart_recovery_2',
  followup_3: 'cart_recovery_3',
};

function findApprovedSyncedTemplateName(syncedTemplates = [], templateName) {
  const target = String(templateName || '').trim();
  if (!target) return null;
  let resolveCanonicalTemplateName = (n) => String(n || '').trim();
  try {
    resolveCanonicalTemplateName = require('../../constants/templateCatalog/catalog').resolveCanonicalTemplateName;
  } catch (_) { /* catalog optional in tests */ }
  const targetCanon = resolveCanonicalTemplateName(target);

  for (const t of syncedTemplates || []) {
    const name = String(t?.name || '').trim();
    if (!name) continue;
    const st = String(t.status || t.metaStatus || t.submissionStatus || '').toUpperCase();
    if (st !== 'APPROVED' && st !== 'ACTIVE') continue;
    const nameCanon = resolveCanonicalTemplateName(name);
    if (name === target || nameCanon === targetCanon || name === targetCanon) {
      return name;
    }
  }
  return null;
}

function cartFollowupSlotFromRule(rule) {
  if (rule?.meta?.systemSlot) return String(rule.meta.systemSlot);
  const id = String(rule.id || '');
  const match = id.match(/^sys_cart_(followup_\d+)$/);
  return match ? match[1] : null;
}

/** Link approved Meta templates onto system cart recovery SAC rules (Phase 6 / BUG-011). */
function autoLinkApprovedTemplatesToSystemRules(automations = [], syncedTemplates = []) {
  if (!Array.isArray(automations) || !automations.length) return automations;

  return automations.map((rule) => {
    if (rule?.meta?.category !== 'abandoned_cart') return rule;
    const slot = cartFollowupSlotFromRule(rule);
    if (!slot) return rule;

    const expectedTemplate = CART_SLOT_TEMPLATE_NAMES[slot];
    if (!expectedTemplate) return rule;

    const approvedName = findApprovedSyncedTemplateName(syncedTemplates, expectedTemplate);
    if (!approvedName) return rule;

    const patch = {};
    if (String(rule.templateName || '') !== approvedName) {
      patch.templateName = approvedName;
    }

    const hadTemplate = Boolean(String(rule.templateName || '').trim());
    const shouldActivate =
      rule.isActive !== true &&
      (rule.meta?.autoActivateOnApproval === true || !hadTemplate);

    if (shouldActivate) {
      patch.isActive = true;
      patch.meta = {
        ...(rule.meta || {}),
        autoActivateOnApproval: false,
        autoLinkedAt: new Date().toISOString(),
      };
    }

    if (Object.keys(patch).length === 0) return rule;
    return { ...rule, ...patch };
  });
}

/**
 * After Meta approves a cart_recovery_* template, attach it to the matching SAC rule.
 */
async function linkApprovedTemplateOnMetaApproval(clientId, templateName) {
  if (!clientId || !templateName) return { linked: 0, activated: 0 };

  let resolveCanonicalTemplateName = (n) => String(n || '').trim();
  try {
    resolveCanonicalTemplateName = require('../../constants/templateCatalog/catalog').resolveCanonicalTemplateName;
  } catch (_) {
    /* catalog optional in tests */
  }

  const canonical = resolveCanonicalTemplateName(templateName);
  const isCartSlot = Object.values(CART_SLOT_TEMPLATE_NAMES).some(
    (n) => n === canonical || n === String(templateName || '').trim()
  );
  if (!isCartSlot) return { linked: 0, activated: 0 };

  const client = await Client.findOne({ clientId })
    .select('commerceAutomations syncedMetaTemplates nicheData')
    .lean();
  if (!client) return { linked: 0, activated: 0 };

  const base =
    Array.isArray(client.commerceAutomations) && client.commerceAutomations.length
      ? client.commerceAutomations
      : mergeSystemAutomations([]);
  const withSystem = mergeSystemAutomations(base);
  const before = JSON.stringify(withSystem);
  const linkedRules = autoLinkApprovedTemplatesToSystemRules(
    withSystem,
    client.syncedMetaTemplates || []
  );
  const merged = pruneDuplicateOrderNotificationRules(
    syncSystemOrderRulesFromNicheMap(linkedRules, client.nicheData || {})
  );
  if (JSON.stringify(merged) === before) return { linked: 0, activated: 0 };

  let linked = 0;
  let activated = 0;
  for (const rule of merged) {
    if (rule?.meta?.category !== 'abandoned_cart') continue;
    const slot = cartFollowupSlotFromRule(rule);
    const expected = CART_SLOT_TEMPLATE_NAMES[slot];
    if (!expected) continue;
    const prev = withSystem.find((r) => r.id === rule.id);
    if (prev && String(prev.templateName || '') !== String(rule.templateName || '')) linked += 1;
    if (prev && !prev.isActive && rule.isActive) activated += 1;
  }

  await persistAutomations(clientId, merged);
  return { linked, activated };
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

async function persistAutomations(clientId, automations) {
  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: {
        commerceAutomations: automations,
        commerceAutomationVersion: COMMERCE_AUTOMATION_VERSION,
      },
    }
  );
  try {
    const { emitToClient } = require('../core/socket');
    emitToClient(clientId, 'commerceAutomationsChanged', {
      clientId,
      at: new Date().toISOString(),
    });
  } catch (_) {
    /* non-fatal */
  }
}

function mergeDuplicateIntoSystemRule(systemRule, duplicate) {
  const patch = {};
  if (!systemRule.templateName && duplicate.templateName) patch.templateName = duplicate.templateName;
  if (!systemRule.isActive && duplicate.isActive) patch.isActive = duplicate.isActive;
  const sysBody = systemRule.variableMappings?.body || {};
  const dupBody = duplicate.variableMappings?.body || {};
  const sysHasMappings = Object.values(sysBody).some((v) => v != null && v !== '');
  const dupHasMappings = Object.values(dupBody).some((v) => v != null && v !== '');
  if (!sysHasMappings && dupHasMappings) {
    patch.variableMappings = duplicate.variableMappings;
    patch.customVariableValues = duplicate.customVariableValues || {};
  }
  const targetIds = resolveTargetProductIds(duplicate);
  if (targetIds.length && !resolveTargetProductIds(systemRule).length) {
    patch.targetProductIds = targetIds;
    patch.triggerScope = 'specific_product';
    patch.productId = duplicate.productId || targetIds[0] || '';
    patch.productTitle = duplicate.productTitle || '';
  }
  return patch;
}

/**
 * Remove legacy rows like "Order paid message" when sys_order_* exists for the same event.
 */
function pruneDuplicateOrderNotificationRules(automations = []) {
  const systemByEvent = new Map();
  for (const rule of automations) {
    if (rule?.meta?.category === 'order_notification' && String(rule.id || '').startsWith('sys_order_')) {
      systemByEvent.set(normalizeEvent(rule.event), rule);
    }
  }
  if (!systemByEvent.size) return automations;

  const removeIds = new Set();
  const patches = new Map();

  for (const rule of automations) {
    if (String(rule.id || '').startsWith('sys_order_')) continue;
    const event = normalizeEvent(rule.event);
    const systemRule = systemByEvent.get(event);
    if (!systemRule) continue;
    if (rule.triggerType !== 'order_status' && rule.meta?.category !== 'order_notification') continue;
    removeIds.add(rule.id);
    const patch = mergeDuplicateIntoSystemRule(systemRule, rule);
    if (Object.keys(patch).length) {
      patches.set(systemRule.id, { ...(patches.get(systemRule.id) || {}), ...patch });
    }
  }

  return automations
    .filter((r) => !removeIds.has(r.id))
    .map((r) => (patches.has(r.id) ? { ...r, ...patches.get(r.id) } : r));
}

async function ensureSystemAutomationsPersisted(clientConfig = {}) {
  const base = await ensureMigration(clientConfig, { persist: false });
  const withSystem = mergeSystemAutomations(base);
  const linked = autoLinkApprovedTemplatesToSystemRules(
    withSystem,
    clientConfig?.syncedMetaTemplates || []
  );
  const merged = pruneDuplicateOrderNotificationRules(
    syncSystemOrderRulesFromNicheMap(linked, clientConfig?.nicheData || {})
  );
  const changed =
    merged.length !== base.length ||
    merged.some((r, i) => {
      const b = base[i];
      return (
        r.id !== b?.id ||
        r.meta?.system !== b?.meta?.system ||
        String(r.templateName || '') !== String(b?.templateName || '') ||
        !!r.isActive !== !!b?.isActive
      );
    });
  if (clientConfig.clientId && changed) {
    const clientUpdate = {
      commerceAutomations: merged,
      commerceAutomationVersion: COMMERCE_AUTOMATION_VERSION,
    };
    for (const rule of merged) {
      if (rule.meta?.category !== 'abandoned_cart' || !rule.templateName) continue;
      const cartPatch = cartFollowupSyncPatch(rule);
      if (cartPatch.wizardFeatures && Object.keys(cartPatch.wizardFeatures).length) {
        Object.assign(
          clientUpdate,
          Object.fromEntries(
            Object.entries(cartPatch.wizardFeatures).map(([k, v]) => [`wizardFeatures.${k}`, v])
          )
        );
      }
      if (cartPatch.nicheData && Object.keys(cartPatch.nicheData).length) {
        Object.assign(
          clientUpdate,
          Object.fromEntries(
            Object.entries(cartPatch.nicheData).map(([k, v]) => [`nicheData.${k}`, v])
          )
        );
      }
      if (cartPatch.cartRecoveryConfig && Object.keys(cartPatch.cartRecoveryConfig).length) {
        Object.assign(
          clientUpdate,
          Object.fromEntries(
            Object.entries(cartPatch.cartRecoveryConfig).map(([k, v]) => [`cartRecoveryConfig.${k}`, v])
          )
        );
      }
    }
    try {
      await withMongoRetry(() =>
        Client.findOneAndUpdate({ clientId: clientConfig.clientId }, { $set: clientUpdate })
      );
    } catch (err) {
      log.warn('commerce automations persist skipped — serving read-only merge', {
        clientId: clientConfig.clientId,
        error: err.message,
        transient: isMongoTransientError(err),
      });
    }
  }
  return merged;
}

/** Read-only merge for API fallback when persist is unavailable. */
function buildAutomationsFromConfig(clientConfig = {}) {
  const base =
    Array.isArray(clientConfig.commerceAutomations) && clientConfig.commerceAutomations.length > 0
      ? clientConfig.commerceAutomations
      : buildUnifiedFromLegacy(clientConfig);
  const withSystem = mergeSystemAutomations(base);
  const linked = autoLinkApprovedTemplatesToSystemRules(
    withSystem,
    clientConfig?.syncedMetaTemplates || []
  );
  return pruneDuplicateOrderNotificationRules(
    syncSystemOrderRulesFromNicheMap(linked, clientConfig?.nicheData || {})
  );
}

async function listAutomations(clientConfig = {}) {
  let list;
  if (Array.isArray(clientConfig.commerceAutomations) && clientConfig.commerceAutomations.length > 0) {
    list = clientConfig.commerceAutomations;
  } else {
    list = buildUnifiedFromLegacy(clientConfig);
    if (clientConfig.clientId && list.length > 0) {
      setImmediate(() => {
        Client.findOneAndUpdate(
          { clientId: clientConfig.clientId },
          {
            $set: {
              commerceAutomations: list,
              commerceAutomationVersion: COMMERCE_AUTOMATION_VERSION,
              commerceAutomationMigratedAt: new Date(),
              commerceAutomationLegacySnapshot: buildLegacySnapshot(clientConfig),
            },
          }
        ).catch(() => {});
      });
    }
  }
  return ensureSystemAutomationsPersisted({ ...clientConfig, commerceAutomations: list });
}

async function syncAbandonedCartFlowFromRules(clientId, automations) {
  const anyCartActive = (automations || []).some(
    (a) => a.meta?.category === 'abandoned_cart' && a.isActive && a.templateName
  );
  const client = await Client.findOne({ clientId }).select('automationFlows wizardFeatures').lean();
  if (!client) return;
  const flows = Array.isArray(client.automationFlows) ? [...client.automationFlows] : [];
  const idx = flows.findIndex((f) => f.id === 'abandoned_cart');
  const patch = {
  };
  if (idx >= 0) {
    flows[idx] = { ...flows[idx], isActive: anyCartActive };
  } else if (anyCartActive) {
    flows.push({ id: 'abandoned_cart', name: 'Abandoned Cart', isActive: true, config: {} });
  }
  await Client.findOneAndUpdate(
    { clientId },
    {
      $set: {
        automationFlows: flows,
        'wizardFeatures.enableAbandonedCart': anyCartActive,
      },
    }
  );
}

async function upsertAutomation(clientId, automation = {}) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error('Client not found');
  const current = await ensureSystemAutomationsPersisted(client);
  const existing = current.find((a) => a.id === automation.id);
  const system = isSystemAutomation(existing || automation);

  if (system && automation.meta?.category === 'abandoned_cart') {
    const delayErr = validateCartFollowupDelay({ ...existing, ...automation, meta: { ...existing?.meta, ...automation.meta } });
    if (delayErr) throw new Error(delayErr);
  }

  /** WS-2 C5 — APPROVED gate on PUT activation.
   *  Previously only `toggleAutomation` enforced template approval. A
   *  merchant saving with `{ isActive: true, templateName: 'draft' }`
   *  would mark the rule live, then every webhook would silently log
   *  `not_approved` and no message reached the customer. We replicate
   *  the toggle's check here for any transition into active state. */
  const activatingNow =
    automation.isActive === true &&
    (existing?.isActive !== true) &&
    automation.actionType !== 'enroll_sequence' &&
    (existing?.actionType !== 'enroll_sequence' || automation.actionType === 'send_template');
  const ruleChannels = Array.isArray(automation.channels)
    ? automation.channels
    : Array.isArray(existing?.channels)
      ? existing.channels
      : ['whatsapp'];
  const wantsWhatsApp = ruleChannels.includes('whatsapp');
  const wantsEmail = ruleChannels.includes('email');

  if (activatingNow) {
    const { ruleIdToShipmentStatus } = require('../../constants/logisticsPartnerRegistry');
    const { assertShipmentRuleEligible } = require('../../services/logisticsEligibilityService');
    if (ruleIdToShipmentStatus(automation.id)) {
      await assertShipmentRuleEligible(clientId, automation.id);
    }
    if (wantsWhatsApp) {
      const tpl = automation.templateName || existing?.templateName || '';
      if (!tpl) {
        const err = new Error('Choose a WhatsApp template before activating this rule.');
        err.code = 'TEMPLATE_REQUIRED';
        err.status = 400;
        throw err;
      }
      const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
      const hit = synced.find((t) => String(t?.name) === String(tpl));
      const status = String(hit?.status || '').toUpperCase();
      if (status !== 'APPROVED' && status !== 'ACTIVE') {
        const reason = !hit
          ? `Template "${tpl}" is not synced from Meta yet.`
          : status === 'REJECTED'
            ? `Template "${tpl}" was rejected by Meta. Edit and resubmit before activating.`
            : `Template "${tpl}" is ${status.toLowerCase() || 'not approved'} on Meta. Wait for approval before activating.`;
        const err = new Error(reason);
        err.code = 'TEMPLATE_NOT_APPROVED';
        err.status = 400;
        throw err;
      }
    }
    if (wantsEmail) {
      const { isWorkspaceEmailReady } = require('../core/emailService');
      const { ruleHasEmailConfig } = require('../core/orderEmailMergeFields');
      if (!isWorkspaceEmailReady(client)) {
        const err = new Error('Connect Gmail in Settings before activating email on this rule.');
        err.code = 'EMAIL_NOT_CONNECTED';
        err.status = 400;
        throw err;
      }
      const mergedRule = { ...existing, ...automation, channels: ruleChannels };
      if (!ruleHasEmailConfig(mergedRule)) {
        const err = new Error('Choose an email template or subject/body before activating email on this rule.');
        err.code = 'EMAIL_TEMPLATE_REQUIRED';
        err.status = 400;
        throw err;
      }
    }
  }

  const incomingTargetIds = Array.isArray(automation.targetProductIds)
    ? automation.targetProductIds.map(normalizeProductId).filter(Boolean)
    : [];
  const legacyProductId = normalizeProductId(automation.productId);
  const targetProductIds = incomingTargetIds.length
    ? [...new Set(incomingTargetIds)]
    : legacyProductId
      ? [legacyProductId]
      : [];
  const triggerScope =
    automation.triggerScope === 'specific_product' || targetProductIds.length
      ? 'specific_product'
      : 'every_order';

  const normalized = {
    id: automation.id || `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: automation.name || 'Automation rule',
    triggerType: automation.triggerType || 'sku_event',
    event: normalizeEvent(automation.event || 'paid'),
    triggerScope,
    targetProductIds,
    matchType:
      automation.matchType === 'contains'
        ? 'contains'
        : automation.matchType === 'starts_with'
          ? 'starts_with'
          : 'exact',
    sku: String(automation.sku || '').trim(),
    productId: targetProductIds[0] || String(automation.productId || '').trim(),
    productTitle: String(automation.productTitle || '').trim(),
    variantId: String(automation.variantId || '').trim(),
    actionType: automation.actionType || 'send_template',
    templateName: automation.templateName || '',
    abTestTemplateName: String(
      automation.abTestTemplateName ?? existing?.abTestTemplateName ?? ''
    ).trim(),
    sequenceId: automation.sequenceId || '',
    language: automation.language || 'en',
    delayMinutes: Number(automation.delayMinutes || 0),
    imageUrl: automation.imageUrl || '',
    isActive:
      automation.isActive === undefined
        ? (existing?.isActive ?? !system)
        : automation.isActive === true,
    variableMappings: seedEcoBodyMappings(
      automation.templateName,
      normalizeAutomationMappings(automation.variableMappings)
    ),
    customVariableValues: automation.customVariableValues || {},
    channels: ruleChannels.filter((c) => c === 'whatsapp' || c === 'email').length
      ? ruleChannels.filter((c) => c === 'whatsapp' || c === 'email')
      : ['whatsapp'],
    emailConfig:
      automation.emailConfig !== undefined
        ? automation.emailConfig
        : existing?.emailConfig ?? null,
    meta: automation.meta || {},
  };

  if (system && existing) {
    normalized.id = existing.id;
    normalized.meta = { ...existing.meta, ...(automation.meta || {}) };
    if (existing.meta?.category === 'order_notification') {
      normalized.name = existing.name;
      normalized.triggerType = 'order_status';
      normalized.event = existing.event;
    }
    if (existing.meta?.category === 'abandoned_cart') {
      normalized.name = existing.name;
      normalized.triggerType = 'abandoned_cart';
      normalized.event = 'abandoned';
      const min = CART_FOLLOWUP_MIN_MINUTES[existing.meta.systemSlot];
      if (min && normalized.delayMinutes < min) {
        throw new Error(validateCartFollowupDelay(normalized));
      }
    }
  }

  const idx = current.findIndex((a) => a.id === normalized.id);
  if (idx >= 0) current[idx] = { ...current[idx], ...normalized };
  else current.push(normalized);

  const merged = mergeSystemAutomations(current);

  const clientUpdate = {
    commerceAutomations: merged,
    commerceAutomationVersion: COMMERCE_AUTOMATION_VERSION,
  };

  const cartPatch = cartFollowupSyncPatch(normalized);
  if (cartPatch.wizardFeatures && Object.keys(cartPatch.wizardFeatures).length) {
    Object.assign(clientUpdate, Object.fromEntries(
      Object.entries(cartPatch.wizardFeatures).map(([k, v]) => [`wizardFeatures.${k}`, v])
    ));
  }
  if (cartPatch.nicheData && Object.keys(cartPatch.nicheData).length) {
    Object.assign(clientUpdate, Object.fromEntries(
      Object.entries(cartPatch.nicheData).map(([k, v]) => [`nicheData.${k}`, v])
    ));
  }
  if (cartPatch.cartRecoveryConfig && Object.keys(cartPatch.cartRecoveryConfig).length) {
    Object.assign(clientUpdate, Object.fromEntries(
      Object.entries(cartPatch.cartRecoveryConfig).map(([k, v]) => [`cartRecoveryConfig.${k}`, v])
    ));
  }
  /** WS-2 H4 — only sync the legacy 5-status nicheData map when the rule
   *  is one of the original CORE statuses. The new `sys_financial_*` and
   *  `sys_fulfillment_*` rules normalize through `normalizeEvent`
   *  (`refunded → cancelled`, `fulfilled → shipped`), which silently
   *  overwrote the merchant's `cancelled` / `shipped` legacy template
   *  when they saved a refund or partial fulfillment rule. */
  const metaCategory = existing?.meta?.category || normalized?.meta?.category;
  const metaGroup = existing?.meta?.group || normalized?.meta?.group;
  const isLegacyOrderRule =
    metaCategory === 'order_notification' &&
    metaGroup !== 'payment_status' &&
    metaGroup !== 'fulfillment_status' &&
    metaGroup !== 'shipment_status';
  if (isLegacyOrderRule) {
    const status = normalizeEvent(existing?.event || normalized?.event);
    if (status && ORDER_STATUS_EVENTS.includes(status)) {
      clientUpdate[`nicheData.orderStatusTemplates.${status}`] =
        normalized.templateName || '';
    }
  }

  await Client.findOneAndUpdate({ clientId }, { $set: clientUpdate });
  await syncAbandonedCartFlowFromRules(clientId, merged);
  return merged.find((a) => a.id === normalized.id) || normalized;
}

async function pauseAutomationsBatch(clientId, automationIds = []) {
  const ids = [...new Set((automationIds || []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error('Client not found');
  const current = await ensureSystemAutomationsPersisted(client);
  const merged = mergeSystemAutomations(
    current.map((a) => (ids.includes(a.id) ? { ...a, isActive: false } : a))
  );
  await persistAutomations(clientId, merged);
  return merged.filter((a) => ids.includes(a.id));
}

async function toggleAutomation(clientId, automationId, { active } = {}) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error('Client not found');
  const current = await ensureSystemAutomationsPersisted(client);
  const existing = current.find((a) => a.id === automationId);
  if (!existing) throw new Error('Rule not found');
  if (active === true && existing.actionType !== 'enroll_sequence') {
    const { normalizeRuleChannels } = require('../core/orderEmailMergeFields');
    const channels = normalizeRuleChannels(existing);
    const emailOnly = channels.includes('email') && !channels.includes('whatsapp');

    if (!emailOnly && !existing.templateName) {
      throw new Error('Choose a WhatsApp template before activating this rule.');
    }

    if (emailOnly) {
      const emailTpl = existing.emailConfig?.templateId || existing.emailConfig?.template;
      if (!emailTpl) {
        throw new Error('Choose an email template before activating this email-only rule.');
      }
    } else {
    const { ruleIdToShipmentStatus } = require('../../constants/logisticsPartnerRegistry');
    const { assertShipmentRuleEligible } = require('../../services/logisticsEligibilityService');
    if (ruleIdToShipmentStatus(automationId)) {
      await assertShipmentRuleEligible(clientId, automationId);
    }
    /** WS-2 guard: refuse to activate a rule whose template is not APPROVED
     *  on Meta. Without this, the webhook silently logs `not_approved` and
     *  no message reaches the customer. */
    const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
    const hit = synced.find((t) => String(t?.name) === String(existing.templateName));
    const status = String(hit?.status || '').toUpperCase();
    if (status !== 'APPROVED' && status !== 'ACTIVE') {
      const reason = !hit
        ? `Template "${existing.templateName}" is not synced from Meta yet.`
        : status === 'REJECTED'
          ? `Template "${existing.templateName}" was rejected by Meta. Edit and resubmit before activating.`
          : `Template "${existing.templateName}" is ${status.toLowerCase() || 'not approved'} on Meta. Wait for approval before activating.`;
      const err = new Error(reason);
      err.code = 'TEMPLATE_NOT_APPROVED';
      err.status = 400;
      throw err;
    }
    }
  }
  return upsertAutomation(clientId, { ...existing, isActive: active === true });
}

async function deleteAutomation(clientId, automationId) {
  const client = await Client.findOne({ clientId });
  if (!client) throw new Error('Client not found');
  const current = await ensureSystemAutomationsPersisted(client);
  const target = current.find((a) => a.id === automationId);
  if (isSystemAutomation(target)) {
    throw new Error('System rules cannot be deleted. Turn the rule off instead.');
  }
  const updated = mergeSystemAutomations(current.filter((a) => a.id !== automationId));
  await persistAutomations(clientId, updated);
  return updated;
}

function getOrderStatusTemplateMap(automations = []) {
  const map = {};
  for (const a of automations) {
    if (
      a.triggerType === 'order_status' &&
      a.isActive &&
      a.templateName &&
      !hasSpecificProductScope(a)
    ) {
      map[normalizeEvent(a.event)] = a.templateName;
    }
  }
  return map;
}

function getActiveCartFollowupRules(automations = []) {
  return (automations || [])
    .filter((a) => a.meta?.category === 'abandoned_cart' && a.isActive)
    .sort((a, b) => (a.meta?.followupStep || 0) - (b.meta?.followupStep || 0));
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

  const statusKeys = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

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
        if (skipOrderStatusRules && !hasSpecificProductScope(automation)) continue;
        if (!matchesProductFilter(automation, order)) continue;
        await runAutomationAction({ clientConfig, order, automation, item: null });
        matched += 1;
        continue;
      }
      if (automation.triggerType === 'abandoned_cart') {
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
    const eventOk = normalizeEvent(normalized.event) === event;
    const productOk = matchesProductFilter(normalized, order);
    return {
      matched: eventOk && productOk,
      reason: eventOk
        ? productOk
          ? hasSpecificProductScope(normalized)
            ? 'product_scope_match'
            : 'order_status_event_check'
          : 'no_product_match'
        : 'event_mismatch',
    };
  }
  if (normalized.triggerType === 'abandoned_cart') {
    return { matched: true, reason: 'abandoned_cart_timing_check' };
  }
  const items = Array.isArray(order?.items) ? order.items : [];
  const item = items.find((i) => matchesSkuRule(normalized, i));
  return { matched: !!item && normalizeEvent(normalized.event) === event, reason: item ? `matched_${item.sku}` : 'no_sku_match' };
}

module.exports = {
  COMMERCE_AUTOMATION_VERSION,
  normalizeEvent,
  ensureMigration,
  ensureSystemAutomationsPersisted,
  buildAutomationsFromConfig,
  sendAutomationTemplate,
  pruneDuplicateOrderNotificationRules,
  listAutomations,
  upsertAutomation,
  toggleAutomation,
  pauseAutomationsBatch,
  deleteAutomation,
  resolveTargetProductIds,
  hasSpecificProductScope,
  matchesProductFilter,
  getOrderStatusTemplateMap,
  getActiveCartFollowupRules,
  syncOrderStatusFromNicheMap,
  syncSystemOrderRulesFromNicheMap,
  runAutomationsForEvent,
  simulateAutomation,
  isSystemAutomation,
  CART_FOLLOWUP_MIN_MINUTES,
  autoLinkApprovedTemplatesToSystemRules,
  linkApprovedTemplateOnMetaApproval,
  cartFollowupSlotFromRule,
};
