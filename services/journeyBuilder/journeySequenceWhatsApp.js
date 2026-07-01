'use strict';

const Order = require('../../models/Order');
const { buildSendContext, buildMetaTemplateComponents } = require('../templateVariableResolver');
const { buildMappedBodyComponent } = require('../../utils/meta/templateParams');
const { buildWaClickTrackUrl } = require('../../utils/wa/waClickTrackingService');

function orderDocToSendPayload(doc) {
  if (!doc) return null;
  const lineItems = (doc.items || []).map((i) => ({
    title: i.name,
    name: i.name,
    quantity: i.quantity || 1,
    image: i.image ? { src: i.image } : undefined,
    image_url: i.image,
  }));
  const ship = doc.shippingAddress && typeof doc.shippingAddress === 'object'
    ? doc.shippingAddress
    : {
      address1: doc.address,
      city: doc.city,
      province: doc.state,
      zip: doc.zip,
    };
  return {
    name: doc.orderNumber || doc.orderId,
    orderNumber: doc.orderNumber || doc.orderId,
    orderId: doc.orderId,
    total_price: doc.totalPrice ?? doc.amount,
    customerName: doc.customerName || doc.name,
    customer: {
      first_name: String(doc.customerName || doc.name || '').split(' ')[0],
      name: doc.customerName || doc.name,
    },
    line_items: lineItems,
    shipping_address: ship,
    fulfillments: doc.trackingUrl ? [{ tracking_url: doc.trackingUrl }] : [],
    payment_method: doc.paymentMethod,
    first_product_image: lineItems[0]?.image?.src || lineItems[0]?.image_url,
  };
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

  const phone = lead?.phoneNumber || seq?.phone || '';
  let orderPayload = null;
  if (seq?.sourceOrderId) {
    const orderDoc = await Order.findOne({
      clientId,
      $or: [
        { shopifyOrderId: String(seq.sourceOrderId) },
        { orderId: String(seq.sourceOrderId) },
        { orderNumber: String(seq.sourceOrderId) },
      ],
    }).lean();
    orderPayload = orderDocToSendPayload(orderDoc);
  }

  const cartSnapshot = lead?.cartSnapshot || lead?.capturedData?.cart || null;
  const useRegistryPath = Boolean(
    orderPayload
    || cartSnapshot
    || (mappings.header || mappings.buttons)
    || Object.values(mappings.body || {}).some((v) => !['name', 'customText', 'businessName', 'tags'].includes(String(v)))
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
      components: tpl?.components || [],
      variableMappings: mappings,
    };

    const headerKey = mappings.header;
    const headerImageUrl =
      headerKey === 'brand_logo_url'
        ? context.brand_logo_url || context.first_product_image
        : context.first_product_image;

    let components = await buildMetaTemplateComponents(metaPayload, context, { headerImageUrl });
    components = injectWaClickTrackingUrl(components, step, clientId, seq?._id);
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
};
