'use strict';

const { sanitizePhoneForStorage, sanitizePhoneFieldsInObject } = require('../core/phoneE164Policy');
const { pickCanonicalPhone } = require('../core/phoneSanitizer');

function lineItemImage(item) {
  if (!item) return '';
  if (item.image_url) return String(item.image_url);
  if (item.imageUrl) return String(item.imageUrl);
  if (item.image && typeof item.image === 'object' && item.image.src) return item.image.src;
  if (typeof item.image === 'string' && item.image.trim()) return item.image.trim();
  return '';
}

function parseLineItemCompareAtPrice(item, variantCompareAtMap) {
  const paid = parseFloat(item?.price);
  const paidNum = Number.isFinite(paid) ? paid : 0;
  const fromLine = item?.compare_at_price ?? item?.compareAtPrice;
  if (fromLine != null && fromLine !== '') {
    const n = parseFloat(fromLine);
    if (Number.isFinite(n) && n > paidNum) return n;
  }
  const vid = item?.variant_id != null ? String(item.variant_id) : '';
  if (vid && variantCompareAtMap && typeof variantCompareAtMap.get === 'function') {
    const catalog = variantCompareAtMap.get(vid);
    if (catalog != null && catalog !== '') {
      const n = Number(catalog);
      if (Number.isFinite(n) && n > paidNum) return n;
    }
  }
  return null;
}

/** Sum of per-unit paid prices × quantity from stored order line items. */
function computeOrderCartValue(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (items.length) {
    const sum = items.reduce((acc, it) => {
      const price = Number(it?.price || 0);
      const qty = Number(it?.quantity || 1);
      if (!Number.isFinite(price) || !Number.isFinite(qty)) return acc;
      return acc + price * qty;
    }, 0);
    if (sum > 0) return sum;
  }
  const fallback = Number(order?.totalPrice ?? order?.amount ?? 0);
  return Number.isFinite(fallback) ? fallback : 0;
}

async function loadVariantCompareAtMap(clientId, ordersOrLineItems) {
  const variantIds = new Set();
  const list = Array.isArray(ordersOrLineItems) ? ordersOrLineItems : [];
  for (const entry of list) {
    const lineItems = entry?.line_items || entry;
    if (!Array.isArray(lineItems)) continue;
    for (const item of lineItems) {
      if (item?.variant_id != null) variantIds.add(String(item.variant_id));
    }
  }
  if (!variantIds.size) return new Map();
  const ShopifyProduct = require('../../models/ShopifyProduct');
  const docs = await ShopifyProduct.find({
    clientId,
    shopifyVariantId: { $in: [...variantIds] },
  })
    .select('shopifyVariantId compareAtPrice')
    .lean();
  return new Map(
    docs.map((d) => [String(d.shopifyVariantId), d.compareAtPrice]).filter(([, v]) => v != null)
  );
}

function resolveCustomerDisplayName(data) {
  const c = data.customer || {};
  const fromCustomer = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  if (fromCustomer) return fromCustomer;
  const bill = data.billing_address || {};
  const fromBill = [bill.first_name, bill.last_name].filter(Boolean).join(' ').trim();
  if (fromBill) return fromBill;
  const ship = data.shipping_address || {};
  const fromShip = [ship.first_name, ship.last_name].filter(Boolean).join(' ').trim();
  if (fromShip) return fromShip;
  return '';
}

/** Human-readable payment gateways string (Shopify REST). */
function paymentGatewaysSummary(data) {
  const names = data.payment_gateway_names;
  if (Array.isArray(names) && names.length) return names.filter(Boolean).join(', ');
  if (data.gateway) return String(data.gateway);
  return '';
}

/** Detect COD from gateways, tags, or note attributes (India / manual COD common). */
function detectCodFromShopify(data) {
  const pg = paymentGatewaysSummary(data).toLowerCase();
  if (pg.includes('cash on delivery') || pg.includes('(cod)') || /\bcod\b/.test(pg)) {
    return true;
  }
  const tags = String(data.tags || '').toLowerCase();
  if (tags.includes('cod')) return true;
  const notes = data.note_attributes || [];
  if (Array.isArray(notes)) {
    for (const n of notes) {
      const v = String(n?.value || '').toLowerCase();
      const nm = String(n?.name || '').toLowerCase();
      if (v.includes('cod') || (nm.includes('payment') && v.includes('cod'))) return true;
    }
  }
  return false;
}

function derivePlatformStatus(data) {
  const fs = String(data.financial_status || '').toLowerCase();
  if (data.cancelled_at) return 'cancelled';
  if (fs === 'refunded' || fs === 'partially_refunded' || fs === 'voided') return 'cancelled';
  if (fs === 'paid') return 'paid';
  const cod = detectCodFromShopify(data);
  if (cod && (fs === 'pending' || fs === 'authorized' || fs === 'partially_paid' || fs === 'unpaid' || fs === '')) {
    return 'pending';
  }
  if (fs === 'authorized' || fs === 'pending' || fs === 'partially_paid' || fs === 'unpaid') return 'pending';
  return 'pending';
}

const DELIVERED_SHIPMENT = new Set(['delivered', 'delivery']);
const SHIPPED_SHIPMENT = new Set([
  'in_transit',
  'out_for_delivery',
  'confirmed',
  'ready_for_pickup',
  'label_printed',
  'shipped',
  'picked_up',
]);

/** Best shipment_status from fulfillments array (Shiprocket / Delhivery write here). */
function resolveFulfillmentShipmentStatus(data) {
  const list = Array.isArray(data?.fulfillments) ? data.fulfillments : [];
  let hasShipped = false;
  for (const f of list) {
    const shipSt = String(f.shipment_status || f.status || '').toLowerCase();
    if (DELIVERED_SHIPMENT.has(shipSt)) return 'delivered';
    if (SHIPPED_SHIPMENT.has(shipSt)) hasShipped = true;
  }
  return hasShipped ? 'shipped' : null;
}

/** Primary carrier tracking from Shopify order payload (3PL writes here). */
function extractPrimaryFulfillment(data) {
  const list = Array.isArray(data?.fulfillments) ? data.fulfillments : [];
  const sorted = [...list].sort((a, b) => {
    const ta = new Date(a.updated_at || a.created_at || 0).getTime();
    const tb = new Date(b.updated_at || b.created_at || 0).getTime();
    return tb - ta;
  });
  const f =
    sorted.find((x) => x.tracking_number || x.tracking_url || (x.tracking_urls || []).length) ||
    sorted[0] ||
    {};
  const urls = f.tracking_urls;
  const url = (Array.isArray(urls) && urls[0]) || f.tracking_url || '';
  return {
    trackingNumber: f.tracking_number != null ? String(f.tracking_number) : '',
    trackingUrl: url ? String(url) : '',
    shipmentStatus: String(f.shipment_status || f.status || '').toLowerCase(),
  };
}

/**
 * Platform status when reconciling from Shopify Admin order JSON (webhooks / sync).
 * Fulfillment from Shiprocket/Delhivery updates Shopify first; we mirror shipped/delivered here.
 */
function deriveLogisticsAwareStatus(data) {
  if (data?.cancelled_at) return 'cancelled';
  const fs = String(data?.financial_status || '').toLowerCase();
  const ful = String(data?.fulfillment_status || '').toLowerCase();
  if (fs === 'refunded' || fs === 'partially_refunded' || fs === 'voided') return 'cancelled';

  const fromShipments = resolveFulfillmentShipmentStatus(data);
  if (fromShipments === 'delivered') return 'delivered';
  if (fromShipments === 'shipped') return 'shipped';

  if (ful === 'fulfilled') return 'shipped';
  if (ful === 'partial') return 'processing';
  return derivePlatformStatus(data);
}

/**
 * Builds the $set payload for upserting a Shopify order into our Order collection.
 * Keeps platform `status` for Kanban / legacy filters; stores raw Shopify financial/fulfillment separately.
 * @param {object} [options] preferLogisticsStatus: use fulfillment-aware status (webhook / 3PL sync)
 */
function buildShopifyOrderSet(clientId, data, options = {}) {
  const phoneCandidates = [
    data.phone,
    data.customer?.phone,
    data.billing_address?.phone,
    data.shipping_address?.phone,
  ];
  const canonicalDigits = pickCanonicalPhone(phoneCandidates, { country: 'IN' });
  const customerPhoneE164 = canonicalDigits ? sanitizePhoneForStorage(canonicalDigits) : '';

  const financialStatus = data.financial_status != null ? String(data.financial_status) : '';
  const fulfillmentStatus =
    data.fulfillment_status != null && data.fulfillment_status !== ''
      ? String(data.fulfillment_status)
      : '';

  const variantCompareAtMap = options.variantCompareAtMap || null;
  const items = (data.line_items || []).map((item) => {
    const paid = parseFloat(item.price);
    const compareAtPrice = parseLineItemCompareAtPrice(item, variantCompareAtMap);
    return {
      name: item.title,
      quantity: item.quantity,
      price: Number.isFinite(paid) ? paid : 0,
      compareAtPrice: compareAtPrice ?? undefined,
      sku: item.sku || '',
      image: lineItemImage(item),
      productId: item.product_id != null ? String(item.product_id) : '',
      variantId: item.variant_id != null ? String(item.variant_id) : '',
    };
  });

  const ff = extractPrimaryFulfillment(data);
  const useLogistics = !!options.preferLogisticsStatus;
  const platformStatus = useLogistics ? deriveLogisticsAwareStatus(data) : derivePlatformStatus(data);

  const shippingAddress = data.shipping_address
    ? sanitizePhoneFieldsInObject({ ...data.shipping_address })
    : undefined;
  const billingAddress = data.billing_address
    ? sanitizePhoneFieldsInObject({ ...data.billing_address })
    : undefined;

  return {
    clientId,
    shopifyOrderId: String(data.id),
    shopifyCustomerId: data.customer?.id != null ? String(data.customer.id) : '',
    orderId: data.name || `#${data.id}`,
    orderNumber: data.order_number != null ? String(data.order_number) : '',
    customerName: resolveCustomerDisplayName(data) || 'Shopify Customer',
    customerPhone: customerPhoneE164,
    phone: customerPhoneE164 || undefined,
    customerEmail: data.email || data.customer?.email || data.contact_email || null,
    checkoutToken: data.checkout_token || data.token ? String(data.checkout_token || data.token) : '',
    amount: parseFloat(data.total_price || 0),
    totalPrice: parseFloat(data.total_price || 0),
    status: platformStatus,
    financialStatus,
    fulfillmentStatus,
    paymentMethod: paymentGatewaysSummary(data) || (data.gateway ? String(data.gateway) : 'Shopify'),
    isCOD: detectCodFromShopify(data),
    items,
    address: data.shipping_address ? `${data.shipping_address.address1}, ${data.shipping_address.city}` : '',
    city: data.shipping_address?.city || '',
    state: data.shipping_address?.province || '',
    zip: data.shipping_address?.zip || '',
    shippingAddress,
    billingAddress,
    createdAt: data.created_at ? new Date(data.created_at) : new Date(),
    storeString: 'Shopify',
    storeKey: options.storeKey || options.shopDomain || '',
    trackingNumber: ff.trackingNumber || '',
    trackingUrl: ff.trackingUrl || '',
    lastShipmentStatus: ff.shipmentStatus || '',
  };
}

function shopifyOrderFilter(clientId, data) {
  const sid = data?.id != null ? String(data.id) : '';
  if (sid) {
    return { clientId, shopifyOrderId: sid };
  }
  const name = data?.name || (data?.order_number != null ? `#${data.order_number}` : '');
  return { clientId, orderId: name };
}

/**
 * Fill missing line-item images from synced ShopifyProduct catalog (variant → product).
 */
async function enrichOrdersLineItemImages(clientId, orders) {
  if (!clientId || !Array.isArray(orders) || !orders.length) return orders;

  const variantIds = new Set();
  const productIds = new Set();
  for (const order of orders) {
    const items = Array.isArray(order?.items) ? order.items : [];
    for (const item of items) {
      if (lineItemImage(item)) continue;
      if (item?.variantId) variantIds.add(String(item.variantId));
      if (item?.productId) productIds.add(String(item.productId));
    }
  }
  if (!variantIds.size && !productIds.size) return orders;

  const ShopifyProduct = require('../../models/ShopifyProduct');
  const or = [];
  if (variantIds.size) or.push({ shopifyVariantId: { $in: [...variantIds] } });
  if (productIds.size) or.push({ shopifyProductId: { $in: [...productIds] } });
  const products = await ShopifyProduct.find({ clientId, $or: or })
    .select('shopifyProductId shopifyVariantId imageUrl')
    .lean();

  const byVariant = new Map();
  const byProduct = new Map();
  for (const p of products) {
    const url = String(p?.imageUrl || '').trim();
    if (!url) continue;
    if (p.shopifyVariantId) byVariant.set(String(p.shopifyVariantId), url);
    if (p.shopifyProductId && !byProduct.has(String(p.shopifyProductId))) {
      byProduct.set(String(p.shopifyProductId), url);
    }
  }

  return orders.map((order) => {
    const items = (Array.isArray(order.items) ? order.items : []).map((item) => {
      const existing = lineItemImage(item);
      if (existing) return { ...item, image: existing };
      const vid = item?.variantId != null ? String(item.variantId) : '';
      const pid = item?.productId != null ? String(item.productId) : '';
      const url = (vid && byVariant.get(vid)) || (pid && byProduct.get(pid)) || '';
      return url ? { ...item, image: url } : item;
    });
    return { ...order, items };
  });
}

module.exports = {
  buildShopifyOrderSet,
  shopifyOrderFilter,
  resolveCustomerDisplayName,
  paymentGatewaysSummary,
  detectCodFromShopify,
  extractPrimaryFulfillment,
  deriveLogisticsAwareStatus,
  resolveFulfillmentShipmentStatus,
  computeOrderCartValue,
  loadVariantCompareAtMap,
  parseLineItemCompareAtPrice,
  enrichOrdersLineItemImages,
  lineItemImage,
};
