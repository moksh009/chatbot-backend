'use strict';

const Client = require('../../models/Client');
const MetaTemplate = require('../../models/MetaTemplate');
const { getPrebuiltByKey } = require('../../constants/prebuiltTemplateLibrary');
const {
  ORDER_STATUS_ECO_REGISTRY,
  buildOrderContextForTemplate,
} = require('../../utils/commerce/orderStatusTemplatePolicy');
const { buildCartRecoveryComponents } = require('../commerce/buildCartRecoveryComponents');
const { buildMetaTemplateComponents, buildSendContext } = require('../../services/templateVariableResolver');

const CART_RECOVERY_TEMPLATE_RE = /cart_recovery|abandoned_cart_r[123]/i;

const ORDER_INFER_PRESETS = {
  paid: ['first_name', 'order_id', 'order_total', 'payment_method'],
  pending: ['first_name', 'order_id', 'order_total', 'payment_method'],
  shipped: ['first_name', 'order_id', 'tracking_url'],
  delivered: ['first_name', 'order_id'],
  cancelled: ['first_name', 'order_id', 'order_total', 'brand_name'],
};

function cartStepFromTemplateName(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('recovery_3') || n.includes('_r3') || n.endsWith('r3_v1')) return 3;
  if (n.includes('recovery_2') || n.includes('_r2') || n.endsWith('r2_v1')) return 2;
  return 1;
}

function isCartRecoveryTemplateName(name) {
  return CART_RECOVERY_TEMPLATE_RE.test(String(name || ''));
}

function getEcoMappingsForTemplate(templateName) {
  const n = String(templateName || '').trim();
  for (const [event, preset] of Object.entries(ORDER_STATUS_ECO_REGISTRY)) {
    if (preset.templateName === n) {
      return { event, variableMappings: preset.variableMappings };
    }
  }
  return null;
}

function extractBodyIndices(syncedTemplate) {
  const comps = syncedTemplate?.components || [];
  const body = comps.find((c) => String(c.type || '').toUpperCase() === 'BODY');
  const matches = body?.text?.match(/\{\{(\d+)\}\}/g) || [];
  return [...new Set(matches.map((m) => parseInt(m.replace(/\D/g, ''), 10)))].sort((a, b) => a - b);
}

function inferBodyMappings(syncedTemplate, event = 'paid') {
  const indices = extractBodyIndices(syncedTemplate);
  const preset = ORDER_INFER_PRESETS[event] || ORDER_INFER_PRESETS.paid;
  const body = {};
  indices.forEach((idx, i) => {
    body[String(idx)] = preset[i] || preset[preset.length - 1] || 'first_name';
  });
  return { body };
}

function normalizeMappingsInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw.body && typeof raw.body === 'object' ? raw.body : raw;
  const out = {};
  Object.entries(body).forEach(([k, v]) => {
    if (v != null && String(v).trim() !== '') out[String(k)] = String(v);
  });
  if (!Object.keys(out).length) return null;
  return { body: out, buttons: raw.buttons || undefined };
}

function buildSampleOrder() {
  return buildOrderContextForTemplate(
    {
      orderNumber: '#TE-1042',
      orderId: 'TE-1042',
      customerName: 'Priya Sharma',
      customerPhone: '919876543210',
      totalPrice: 2499,
      paymentMethod: 'Prepaid',
      isCOD: false,
      items: [
        {
          name: 'Smart Doorbell Pro',
          sku: 'SKU-001',
          image: 'https://images.unsplash.com/photo-1558618666-fcd25c85f82e?w=400',
        },
      ],
      shippingAddress: {
        address1: '12 MG Road',
        city: 'Bangalore',
        province: 'KA',
        zip: '560001',
      },
    },
    { trackingUrl: 'https://track.example.com/TE-1042' }
  );
}

function buildMockCartLead(client = {}) {
  const host = client.shopDomain
    ? String(client.shopDomain).replace(/^https?:\/\//, '').split('/')[0]
    : 'your-store.myshopify.com';
  const checkoutUrl = `https://${host}/cart/recover/demo-token`;
  return {
    name: 'Priya',
    firstName: 'Priya',
    phoneNumber: '919876543210',
    checkoutToken: 'demo-token',
    checkoutUrl,
    cartSnapshot: {
      items: [
        {
          title: 'Smart Doorbell Pro',
          image: 'https://images.unsplash.com/photo-1558618666-fcd25c85f82e?w=400',
          price: '2499',
        },
      ],
      total_price: '2499',
      checkoutUrl,
    },
  };
}

function findSyncedTemplate(client, templateName) {
  const list = Array.isArray(client?.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  const want = String(templateName || '').toLowerCase();
  return list.find((t) => String(t?.name || '').toLowerCase() === want) || null;
}

async function resolveRuleMappings(clientId, ruleId, templateName) {
  if (!clientId) return null;
  try {
    const commerceAutomationService = require('../commerce/commerceAutomationService');
    const fullClient = await Client.findOne({ clientId })
      .select('clientId commerceAutomations nicheData syncedMetaTemplates wizardFeatures')
      .lean();
    if (!fullClient) return null;
    const automations = await commerceAutomationService.ensureSystemAutomationsPersisted(fullClient);
    const rule =
      (ruleId && automations.find((r) => r.id === ruleId)) ||
      automations.find((r) => String(r.templateName || '') === String(templateName || ''));
    if (!rule) return null;
    const normalized = normalizeMappingsInput(rule.variableMappings);
    return normalized ? { mappings: normalized, event: rule.event, triggerType: rule.triggerType } : null;
  } catch {
    return null;
  }
}

/**
 * Build Meta Cloud API components for POST /meta-ads/test-template.
 */
async function buildTestTemplatePayload({
  clientId,
  templateName,
  variableMappings: inputMappings,
  triggerType,
  event,
  ruleId,
  followupStep,
  customVariableValues,
}) {
  const client = await Client.findOne({ clientId })
    .select('clientId businessName brandName nicheData businessLogo shopDomain syncedMetaTemplates')
    .lean();
  if (!client) {
    throw new Error('Client not found');
  }

  const name = String(templateName || '').trim();
  if (!name) throw new Error('templateName is required');

  if (isCartRecoveryTemplateName(name)) {
    const step = Number(followupStep) || cartStepFromTemplateName(name);
    const lead = buildMockCartLead(client);
    const { components } = buildCartRecoveryComponents(lead, client, step);
    return { components, mode: 'cart_recovery_sample' };
  }

  const synced = findSyncedTemplate(client, name);
  let draft = null;
  if (!synced) {
    draft = await MetaTemplate.findOne({ clientId, name }).lean();
  }

  const ruleResolved = await resolveRuleMappings(clientId, ruleId, name);
  const ecoHit = getEcoMappingsForTemplate(name);

  let variableMappings =
    normalizeMappingsInput(inputMappings) ||
    ruleResolved?.mappings ||
    ecoHit?.variableMappings ||
    null;

  if (!variableMappings?.body || !Object.keys(variableMappings.body).length) {
    const prebuilt = getPrebuiltByKey(name);
    if (prebuilt?.variableMappings) {
      variableMappings = prebuilt.variableMappings;
    }
  }

  const eventKey =
    String(event || ruleResolved?.event || ecoHit?.event || 'paid').toLowerCase() || 'paid';

  if (!variableMappings?.body || !Object.keys(variableMappings.body).length) {
    variableMappings = inferBodyMappings(synced || draft, eventKey);
  }

  const orderDoc = buildSampleOrder();
  const flatContext = await buildSendContext({
    client,
    phone: '919876543210',
    order: orderDoc,
    extra: {
      brand_name: client.businessName || client.brandName || 'Your Store',
      first_product_image:
        orderDoc.line_items?.[0]?.image?.src ||
        client.nicheData?.businessLogo ||
        client.businessLogo ||
        'https://images.unsplash.com/photo-1558618666-fcd25c85f82e?w=400',
      checkout_url: buildMockCartLead(client).checkoutUrl,
      cart_total: '₹2,499',
      product_name: 'Smart Doorbell Pro',
      discount_code: 'SAVE10',
      _customVariableValues: customVariableValues || {},
    },
  });
  flatContext._clientDoc = client;

  const metaPayload = synced
    ? { ...synced, variableMappings }
    : draft
      ? { ...draft, components: draft.components, variableMappings }
      : { name, variableMappings, components: [] };

  if (!synced && !draft?.components?.length) {
    const indices = Object.keys(variableMappings.body || {})
      .map(Number)
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    const parameters = indices.map((pos) => {
      const reg = variableMappings.body[String(pos)] || variableMappings.body[pos];
      const val =
        reg === 'customText'
          ? (customVariableValues?.[pos] ?? customVariableValues?.[String(pos)] ?? 'Sample')
          : flatContext[reg] || '—';
      return { type: 'text', text: String(val).slice(0, 1024) };
    });
    if (parameters.length) {
      return {
        components: [{ type: 'body', parameters }],
        mode: 'inferred_body_only',
      };
    }
  }

  const headerImageUrl =
    flatContext.first_product_image ||
    client.nicheData?.businessLogo ||
    client.businessLogo ||
    '';

  const components = await buildMetaTemplateComponents(metaPayload, flatContext, {
    headerImageUrl,
  });

  const bodyIndices = extractBodyIndices(metaPayload);
  const bodyComp = components.find((c) => c.type === 'body');
  const sentCount = bodyComp?.parameters?.length || 0;

  if (bodyIndices.length && sentCount < bodyIndices.length) {
    const parameters = bodyIndices.map((pos) => {
      const reg = variableMappings.body[String(pos)] || variableMappings.body[pos];
      let val = flatContext[reg];
      if (reg === 'customText') {
        val =
          customVariableValues?.[pos] ??
          customVariableValues?.[String(pos)] ??
          'Sample';
      }
      return { type: 'text', text: String(val ?? '—').slice(0, 1024) };
    });
    const rest = components.filter((c) => c.type !== 'body');
    return {
      components: [...rest, { type: 'body', parameters }],
      mode: 'body_rebuilt',
    };
  }

  return { components, mode: synced ? 'synced_components' : 'draft_components' };
}

module.exports = {
  buildTestTemplatePayload,
  isCartRecoveryTemplateName,
  cartStepFromTemplateName,
  buildMockCartLead,
};
