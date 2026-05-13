'use strict';

function lineItemImage(item) {
  if (!item) return '';
  if (item.image && typeof item.image === 'object' && item.image.src) return item.image.src;
  if (typeof item.image === 'string') return item.image;
  return '';
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

/** Primary carrier tracking from Shopify order payload (3PL writes here). */
function extractPrimaryFulfillment(data) {
  const list = Array.isArray(data?.fulfillments) ? data.fulfillments : [];
  const f = list[0] || {};
  const urls = f.tracking_urls;
  const url = (Array.isArray(urls) && urls[0]) || f.tracking_url || '';
  return {
    trackingNumber: f.tracking_number != null ? String(f.tracking_number) : '',
    trackingUrl: url ? String(url) : '',
  };
}

/**
 * Platform status when reconciling from Shopify Admin order JSON (webhooks / sync).
 * Fulfillment from Shiprocket/Delhivery updates Shopify first; we mirror shipped here.
 */
function deriveLogisticsAwareStatus(data) {
  if (data?.cancelled_at) return 'cancelled';
  const fs = String(data?.financial_status || '').toLowerCase();
  const ful = String(data?.fulfillment_status || '').toLowerCase();
  if (fs === 'refunded' || fs === 'partially_refunded' || fs === 'voided') return 'cancelled';
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
  const phone = data.phone || data.customer?.phone || data.billing_address?.phone || data.shipping_address?.phone;
  const cleanPhone = phone ? String(phone).replace(/\D/g, '').slice(-10) : '0000000000';

  const financialStatus = data.financial_status != null ? String(data.financial_status) : '';
  const fulfillmentStatus =
    data.fulfillment_status != null && data.fulfillment_status !== ''
      ? String(data.fulfillment_status)
      : '';

  const items = (data.line_items || []).map((item) => ({
    name: item.title,
    quantity: item.quantity,
    price: parseFloat(item.price),
    sku: item.sku || '',
    image: lineItemImage(item),
  }));

  const ff = extractPrimaryFulfillment(data);
  const useLogistics = !!options.preferLogisticsStatus;
  const platformStatus = useLogistics ? deriveLogisticsAwareStatus(data) : derivePlatformStatus(data);

  return {
    clientId,
    shopifyOrderId: String(data.id),
    orderId: data.name || `#${data.id}`,
    orderNumber: data.order_number != null ? String(data.order_number) : '',
    customerName: resolveCustomerDisplayName(data) || 'Shopify Customer',
    customerPhone: cleanPhone,
    customerEmail: data.email || data.customer?.email || null,
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
    shippingAddress: data.shipping_address || undefined,
    billingAddress: data.billing_address || undefined,
    createdAt: data.created_at ? new Date(data.created_at) : new Date(),
    storeString: 'Shopify',
    trackingNumber: ff.trackingNumber || '',
    trackingUrl: ff.trackingUrl || '',
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

module.exports = {
  buildShopifyOrderSet,
  shopifyOrderFilter,
  resolveCustomerDisplayName,
  paymentGatewaysSummary,
  detectCodFromShopify,
  extractPrimaryFulfillment,
  deriveLogisticsAwareStatus,
};
