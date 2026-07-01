'use strict';

const Order = require('../../models/Order');
const { buildSendContext, buildMetaTemplateComponents } = require('../templateVariableResolver');
const { buildMappedBodyComponent } = require('../../utils/meta/templateParams');
const { buildWaClickTrackUrl } = require('../../utils/wa/waClickTrackingService');
const {
  ORDER_STATUS_ECO_REGISTRY,
  isEcoTemplateName,
  buildOrderContextForTemplate,
} = require('../../utils/commerce/orderMessageTemplatePolicy');
const { getOrderMessageBlueprint } = require('../../constants/orderMessageWaBlueprints');
const { resolveHeaderImageUrl } = require('../templateBrandOverrides');

/** Extended eco / order-status body slot mappings (mirrors commerceAutomationService). */
const EXTENDED_ECO_BODY_MAPPINGS = {
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
  order_in_transit: { 1: 'first_name', 2: 'order_id', 3: 'tracking_url' },
  order_out_for_delivery: { 1: 'first_name', 2: 'order_id' },
  order_delivered_update: { 1: 'first_name', 2: 'order_id' },
  delivery_attempt_failed: { 1: 'first_name', 2: 'order_id' },
  rto_ndr_rescue: { 1: 'first_name', 2: 'order_id', 3: 'tracking_url' },
};

const ORDER_CONTEXT_FIELDS = new Set([
  'first_name',
  'order_id',
  'order_number',
  'order_items',
  'order_total',
  'payment_method',
  'tracking_url',
  'shipping_address',
  'brand_logo_url',
  'first_product_image',
]);

function orderDocToSendPayload(doc) {
  if (!doc) return null;
  return buildOrderContextForTemplate(
    {
      orderNumber: doc.orderNumber || doc.orderId,
      orderId: doc.orderId,
      customerName: doc.customerName || doc.name,
      customerPhone: doc.customerPhone || doc.phone,
      totalPrice: doc.totalPrice ?? doc.amount,
      paymentMethod: doc.paymentMethod,
      isCOD: doc.isCOD,
      items: doc.items || [],
      shippingAddress: doc.shippingAddress,
      trackingUrl: doc.trackingUrl,
    },
    { trackingUrl: doc.trackingUrl }
  );
}

function getEcoBodyMappingsForTemplate(templateName) {
  const name = String(templateName || '').trim();
  if (!name) return null;
  for (const preset of Object.values(ORDER_STATUS_ECO_REGISTRY)) {
    if (preset.templateName === name && preset.variableMappings?.body) {
      return { ...preset.variableMappings.body };
    }
  }
  const extended = EXTENDED_ECO_BODY_MAPPINGS[name];
  return extended ? { ...extended } : null;
}

function seedEcoTemplateMappings(templateName, mappings = {}) {
  const ecoBody = getEcoBodyMappingsForTemplate(templateName);
  if (!ecoBody) return mappings;
  const body = { ...(mappings.body || {}) };
  let touched = false;
  for (const [pos, field] of Object.entries(ecoBody)) {
    if (!body[pos]) {
      body[pos] = field;
      touched = true;
    }
  }
  if (String(templateName || '').trim() === 'eco_order_confirmed' && body['3'] === 'order_total') {
    body['3'] = 'order_items';
    touched = true;
  }
  if (!touched && Object.keys(body).length) return mappings;
  return { ...mappings, body };
}

function mergeBlueprintHeaderComponents(templateName, components = []) {
  const blueprint = getOrderMessageBlueprint(templateName);
  if (!blueprint?.components?.length) return components;

  const merged = [...(components || [])];
  const hasHeader = merged.some((c) => String(c.type || '').toUpperCase() === 'HEADER');
  if (hasHeader) return merged;

  const bpHeader = blueprint.components.find((c) => String(c.type || '').toUpperCase() === 'HEADER');
  if (bpHeader) merged.unshift({ ...bpHeader });

  return merged;
}

function templateRequiresImageHeader(components = []) {
  const header = (components || []).find((c) => String(c.type || '').toUpperCase() === 'HEADER');
  return String(header?.format || '').toUpperCase() === 'IMAGE';
}

function resolveBlueprintHeaderImageUrl(components = []) {
  const header = (components || []).find((c) => String(c.type || '').toUpperCase() === 'HEADER');
  if (!header || String(header.format || '').toUpperCase() !== 'IMAGE') return null;
  if (header._imageUrl && /^https?:\/\//i.test(String(header._imageUrl))) {
    return String(header._imageUrl);
  }
  const handle = Array.isArray(header.example?.header_handle)
    ? header.example.header_handle[0]
    : null;
  if (handle && /^https?:\/\//i.test(String(handle))) return String(handle);
  return null;
}

function componentHasImageHeader(components = []) {
  return (components || []).some((c) => {
    if (String(c.type || '').toLowerCase() !== 'header') return false;
    return (c.parameters || []).some((p) => p?.type === 'image' && (p.image?.link || p.image?.id));
  });
}

/**
 * MetaTemplate docs omit components[] — merge from synced catalog / blueprints / body text.
 * Synced catalogs often store BODY only; eco_* blueprints supply the IMAGE header definition.
 */
function resolveTemplateComponents(templateName, tpl = {}, client = {}) {
  const name = String(templateName || '').trim();
  const synced = (client?.syncedMetaTemplates || []).find(
    (t) => String(t.name || '').trim() === name
  );

  const existing = tpl?.components || tpl?.metaComponents;
  if (Array.isArray(existing) && existing.length) {
    return mergeBlueprintHeaderComponents(name, existing);
  }
  if (synced?.components?.length) {
    return mergeBlueprintHeaderComponents(name, synced.components);
  }

  const blueprint = getOrderMessageBlueprint(name);
  if (blueprint?.components?.length) return blueprint.components;

  const bodyText =
    tpl?.body
    || tpl?.formData?.bodyText
    || tpl?.formData?.body
    || synced?.body
    || '';
  if (bodyText && /\{\{\d+\}\}/.test(String(bodyText))) {
    return mergeBlueprintHeaderComponents(name, [{ type: 'BODY', text: String(bodyText) }]);
  }
  return [];
}

function countExpectedBodyParams(components = []) {
  const body = (components || []).find((c) => String(c.type || '').toUpperCase() === 'BODY');
  const matches = String(body?.text || '').match(/\{\{(\d+)\}\}/g) || [];
  return new Set(matches.map((m) => m.replace(/[{}]/g, ''))).size;
}

function countBodyParameters(components = []) {
  const body = (components || []).find((c) => String(c.type || '').toLowerCase() === 'body');
  return body?.parameters?.length || 0;
}

function mappingsNeedOrderContext(mappings = {}) {
  return Object.values(mappings.body || {}).some((v) => ORDER_CONTEXT_FIELDS.has(String(v)));
}

async function findOrderDocForSequence(clientId, seq, phone = '') {
  if (seq?.sourceOrderId) {
    const byId = await Order.findOne({
      clientId,
      $or: [
        { shopifyOrderId: String(seq.sourceOrderId) },
        { orderId: String(seq.sourceOrderId) },
        { orderNumber: String(seq.sourceOrderId) },
      ],
    }).lean();
    if (byId) return byId;
  }

  const digits = String(phone || seq?.phone || '').replace(/\D/g, '');
  if (digits.length < 8) return null;
  const suffix = digits.slice(-10);
  return Order.findOne({
    clientId,
    $or: [
      { customerPhone: { $regex: `${suffix}$` } },
      { phone: { $regex: `${suffix}$` } },
    ],
  })
    .sort({ createdAt: -1 })
    .lean();
}

function normalizeStepMappings(step = {}) {
  const nested = step.variableMappings && typeof step.variableMappings === 'object'
    ? step.variableMappings
    : null;
  const flat = step.variableMapping && typeof step.variableMapping === 'object'
    ? step.variableMapping
    : null;
  const body = nested?.body || flat || {};
  const out = { body: { ...body } };
  const header = nested?.header || step.headerImageField;
  if (header) out.header = header;
  if (nested?.buttons && Object.keys(nested.buttons).length) {
    out.buttons = { ...nested.buttons };
  }
  return out;
}

function inferDefaultVariableMapping(components = []) {
  const body = (components || []).find((c) => String(c.type || '').toUpperCase() === 'BODY');
  const text = body?.text || '';
  const matches = text.match(/\{\{(\d+)\}\}/g) || [];
  const indices = [...new Set(matches.map((m) => m.replace(/[{}]/g, '')))].sort((a, b) => Number(a) - Number(b));
  const mapping = {};
  for (const idx of indices) {
    mapping[idx] = idx === '1' ? 'name' : 'customText';
  }
  return mapping;
}

/**
 * If the step has a URL button flagged for tracking, inject the tracked redirect
 * URL into the components array (replaces the last cta_url button component).
 * Only applies to dynamic URL buttons (variable in button URL).
 */
function injectWaClickTrackingUrl(components, step, clientId, seqId) {
  if (!step.hasUrlButton) return components;
  const destination = step.urlButtonDestination;
  if (!destination) return components;

  const trackedUrl = buildWaClickTrackUrl(
    String(seqId),
    Number(step.stepIndex || 0),
    clientId,
    destination
  );

  // Replace the URL in any cta_url button component
  return (components || []).map((comp) => {
    if (String(comp.type || '').toUpperCase() !== 'BUTTON') return comp;
    if (String(comp.sub_type || '').toUpperCase() !== 'URL') return comp;
    return { ...comp, parameters: [{ type: 'text', text: trackedUrl }] };
  });
}

/**
 * Build WhatsApp template payload for journey / sequence steps.
 * Uses order/cart context when available (sourceOrderId or lead cart snapshot).
 */
async function buildJourneySequenceWhatsAppPayload({ client, clientId, step, lead, seq }) {
  const templateName = step.templateName;
  const { resolveTemplateForSend } = require('../templateResolver');
  const resolved = await resolveTemplateForSend(clientId, { name: templateName });
  const tpl = resolved?.template;

  let mappings = normalizeStepMappings(step);
  if (!Object.keys(mappings.body || {}).length) {
    const fromTpl =
      tpl?.variableMappings?.body || tpl?.variableMapping?.body || tpl?.variableMapping;
    if (fromTpl && typeof fromTpl === 'object' && Object.keys(fromTpl).length) {
      mappings = { ...mappings, body: { ...fromTpl } };
    } else {
      mappings = { ...mappings, body: inferDefaultVariableMapping(tpl?.components) };
    }
  }
  mappings = seedEcoTemplateMappings(templateName, mappings);

  const phone = lead?.phoneNumber || seq?.phone || '';
  const orderDoc = await findOrderDocForSequence(clientId, seq, phone);
  const orderPayload = orderDocToSendPayload(orderDoc);

  const cartSnapshot = lead?.cartSnapshot || lead?.capturedData?.cart || null;
  const templateComponents = resolveTemplateComponents(templateName, tpl, client);
  const useRegistryPath = Boolean(
    orderPayload
    || cartSnapshot
    || isEcoTemplateName(templateName)
    || mappingsNeedOrderContext(mappings)
    || mappings.header
    || mappings.buttons
    || templateComponents.length
    || Object.values(mappings.body || {}).some(
      (v) => !['name', 'customText', 'businessName', 'tags'].includes(String(v))
    )
  );

  if (useRegistryPath) {
    const context = await buildSendContext({
      client,
      phone,
      lead,
      order: orderPayload,
      cart: cartSnapshot,
      extra: {
        customVariableValues: step.customVariableValues || {},
        _customVariableValues: step.customVariableValues || {},
      },
    });
    context._clientDoc = client;
    context._leadDoc = lead;

    const metaPayload = {
      ...(tpl || {}),
      name: templateName,
      components: templateComponents,
      variableMappings: mappings,
    };

    const headerImageUrl =
      resolveHeaderImageUrl(context, metaPayload, client, step.automationSlotId)
      || resolveBlueprintHeaderImageUrl(templateComponents);

    let components = await buildMetaTemplateComponents(metaPayload, context, { headerImageUrl });
    components = injectWaClickTrackingUrl(components, step, clientId, seq?._id);

    if (templateRequiresImageHeader(templateComponents) && !componentHasImageHeader(components)) {
      const err = new Error('template_header_image_missing');
      err.code = 'template_header_image_missing';
      throw err;
    }

    const expectedParams = countExpectedBodyParams(templateComponents);
    const actualParams = countBodyParameters(components);
    if (expectedParams > 0 && actualParams === 0) {
      const err = new Error('template_variables_missing');
      err.code = 'template_variables_missing';
      err.expectedParams = expectedParams;
      throw err;
    }

    return {
      templateName,
      templateLanguage: tpl?.language || step.templateLanguage || 'en',
      components,
    };
  }

  const row = {
    name: lead?.name || seq?.name || 'Customer',
    customerName: lead?.name || seq?.name || 'Customer',
    phone,
    email: lead?.email || seq?.email,
    tags: lead?.tags,
    totalSpent: lead?.totalSpent,
    lastPurchaseDate: lead?.lastPurchaseDate,
    capturedData: lead?.capturedData,
  };

  const mappedBody = buildMappedBodyComponent({
    variableMapping: mappings.body,
    row,
    customTextValues: step.customVariableValues || {},
    client,
  });

  let simpleComponents = mappedBody ? [mappedBody] : [];
  simpleComponents = injectWaClickTrackingUrl(simpleComponents, step, clientId, seq?._id);

  const expectedParams = countExpectedBodyParams(templateComponents);
  const actualParams = countBodyParameters(simpleComponents);
  if (expectedParams > 0 && actualParams === 0) {
    const err = new Error('template_variables_missing');
    err.code = 'template_variables_missing';
    err.expectedParams = expectedParams;
    throw err;
  }

  return {
    templateName,
    templateLanguage: tpl?.language || step.templateLanguage || 'en',
    components: simpleComponents,
  };
}

module.exports = {
  buildJourneySequenceWhatsAppPayload,
  orderDocToSendPayload,
  normalizeStepMappings,
  seedEcoTemplateMappings,
  findOrderDocForSequence,
  getEcoBodyMappingsForTemplate,
  resolveTemplateComponents,
  mergeBlueprintHeaderComponents,
  templateRequiresImageHeader,
  resolveBlueprintHeaderImageUrl,
  componentHasImageHeader,
  countExpectedBodyParams,
  countBodyParameters,
};
