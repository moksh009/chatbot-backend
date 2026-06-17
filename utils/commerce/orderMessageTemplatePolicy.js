'use strict';

/**
 * Order-message template presets (eco registry + order context builder).
 * Per-rule Meta allowlists live in `utils/meta/orderMessageTemplatePolicy.js`.
 */
const ORDER_STATUS_ECO_REGISTRY = {
  paid: {
    templateName: 'eco_order_confirmed',
    label: 'Order paid',
    variableMappings: {
      body: { 1: 'first_name', 2: 'order_id', 3: 'order_items', 4: 'payment_method' },
    },
  },
  shipped: {
    templateName: 'eco_shipping_update',
    label: 'Order shipped',
    variableMappings: {
      body: { 1: 'first_name', 2: 'order_id', 3: 'tracking_url' },
    },
  },
  delivered: {
    templateName: 'eco_delivered',
    label: 'Order delivered',
    variableMappings: {
      body: { 1: 'first_name', 2: 'order_id' },
    },
  },
};

const CORE_STATUSES = ['paid', 'shipped', 'delivered'];

function normalizeStatusKey(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'fulfilled') return 'shipped';
  if (s === 'processing') return 'paid';
  return s;
}

function isEcoTemplateName(name) {
  return Object.values(ORDER_STATUS_ECO_REGISTRY).some((r) => r.templateName === name);
}

function getEcoPreset(status) {
  return ORDER_STATUS_ECO_REGISTRY[normalizeStatusKey(status)] || null;
}

function sanitizeOrderStatusTemplates(raw = {}) {
  const out = {};
  const input = typeof raw === 'object' ? raw : {};

  for (const status of CORE_STATUSES) {
    const preset = ORDER_STATUS_ECO_REGISTRY[status];
    const chosen = input[status];
    if (chosen === preset.templateName) {
      out[status] = chosen;
    }
  }

  if (input.cancelled && typeof input.cancelled === 'string' && input.cancelled.trim()) {
    out.cancelled = String(input.cancelled).trim();
  }

  return out;
}

function validateOrderStatusTemplates(raw = {}, syncedTemplates = []) {
  const errors = [];
  const warnings = [];
  const sanitized = sanitizeOrderStatusTemplates(raw);

  for (const status of CORE_STATUSES) {
    const preset = ORDER_STATUS_ECO_REGISTRY[status];
    const chosen = raw[status];
    if (!chosen) continue;
    if (chosen !== preset.templateName) {
      errors.push({
        status,
        code: 'NON_ECO_TEMPLATE',
        message: `${preset.label} must use the official template "${preset.templateName}". Other templates use different variables and will fail at send time.`,
      });
      delete sanitized[status];
    } else {
      const synced = syncedTemplates.find((t) => t.name === chosen);
      const st = String(synced?.status || '').toUpperCase();
      if (!synced) {
        warnings.push({
          status,
          code: 'NOT_PUSHED',
          message: `Push "${preset.templateName}" to Meta before going live.`,
        });
      } else if (st !== 'APPROVED' && st !== 'ACTIVE') {
        warnings.push({
          status,
          code: 'NOT_APPROVED',
          message: `"${preset.templateName}" is not approved on Meta yet.`,
        });
      }
    }
  }

  return { sanitized, errors, warnings, valid: errors.length === 0 };
}

function buildOrderContextForTemplate(order = {}, { trackingUrl, trackingNumber, nicheData } = {}) {
  let finalTrackingUrl = trackingUrl || order.trackingUrl;
  if (!finalTrackingUrl && (trackingNumber || order.trackingNumber) && nicheData?.trackingLinkPattern) {
    finalTrackingUrl = nicheData.trackingLinkPattern.replace(
      '{{tracking_number}}',
      trackingNumber || order.trackingNumber || ''
    );
  }

  const items = order.items || [];
  const line_items = items.map((i) => ({
    title: i.name || i.title,
    name: i.name || i.title,
    sku: i.sku,
    quantity: i.quantity || 1,
    image: i.image ? (typeof i.image === 'string' ? { src: i.image } : i.image) : undefined,
  }));

  const { formatLineItemsSummary } = require('./orderLineItemEnrichment');

  return {
    name: order.orderNumber || order.orderId,
    orderNumber: order.orderNumber || order.orderId,
    orderId: order.orderId,
    customerName: order.customerName,
    customer: {
      first_name: (order.customerName || 'Customer').split(' ')[0],
      name: order.customerName,
    },
    line_items: line_items.length
      ? line_items
      : items.map((i) => ({
          title: i.name,
          name: i.name,
          sku: i.sku,
          image: i.image ? { src: i.image } : undefined,
        })),
    itemsSummary: formatLineItemsSummary(
      items.map((i) => ({
        title: i.name || i.title,
        quantity: i.quantity || 1,
        variant_title: i.variant_title || '',
      }))
    ),
    total_price: order.totalPrice ?? order.amount,
    totalPrice: order.totalPrice,
    payment_method: order.paymentMethod || (order.isCOD ? 'Cash on Delivery' : 'Prepaid'),
    isCOD: order.isCOD,
    shipping_address: order.shippingAddress,
    fulfillments: finalTrackingUrl ? [{ tracking_url: finalTrackingUrl }] : [],
    phone: order.customerPhone || order.phone,
  };
}

module.exports = {
  ORDER_STATUS_ECO_REGISTRY,
  CORE_STATUSES,
  normalizeStatusKey,
  isEcoTemplateName,
  getEcoPreset,
  sanitizeOrderStatusTemplates,
  validateOrderStatusTemplates,
  buildOrderContextForTemplate,
};
