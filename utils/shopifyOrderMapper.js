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

function derivePlatformStatus(data) {
  const fs = String(data.financial_status || '').toLowerCase();
  if (data.cancelled_at) return 'cancelled';
  if (fs === 'refunded' || fs === 'partially_refunded' || fs === 'voided') return 'cancelled';
  if (fs === 'paid') return 'paid';
  return 'pending';
}

/**
 * Builds the $set payload for upserting a Shopify order into our Order collection.
 * Keeps platform `status` for Kanban / legacy filters; stores raw Shopify financial/fulfillment separately.
 */
function buildShopifyOrderSet(clientId, data) {
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
    status: derivePlatformStatus(data),
    financialStatus,
    fulfillmentStatus,
    paymentMethod: data.gateway || 'Shopify',
    isCOD:
      String(data.gateway || '')
        .toLowerCase()
        .includes('cash on delivery') ||
      String(data.gateway || '')
        .toLowerCase()
        .includes('cod') ||
      (Array.isArray(data.payment_gateway_names) &&
        data.payment_gateway_names.join('').toLowerCase().includes('cod')),
    items,
    address: data.shipping_address ? `${data.shipping_address.address1}, ${data.shipping_address.city}` : '',
    city: data.shipping_address?.city || '',
    state: data.shipping_address?.province || '',
    zip: data.shipping_address?.zip || '',
    shippingAddress: data.shipping_address || undefined,
    billingAddress: data.billing_address || undefined,
    createdAt: data.created_at ? new Date(data.created_at) : new Date(),
    storeString: 'Shopify',
  };
}

function shopifyOrderFilter(clientId, data) {
  return {
    clientId,
    $or: [{ shopifyOrderId: String(data.id) }, { orderId: data.name || `#${data.id}` }],
  };
}

module.exports = {
  buildShopifyOrderSet,
  shopifyOrderFilter,
  resolveCustomerDisplayName,
};
