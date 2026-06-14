'use strict';

const Order = require('../../models/Order');
const NdrAction = require('../../models/NdrAction');
const Conversation = require('../../models/Conversation');
const { normalizePhone } = require('../core/helpers');
const { ndrReattempt, hasShiprocketApiCredentials } = require('../../services/shiprocketApiClient');

const NDR_FLOW_TTL_MS = 48 * 60 * 60 * 1000;

function parseIndianMobile(text) {
  const raw = String(text || '');
  const matches = raw.match(/(?:^|\D)([6-9]\d{9})(?:\D|$)/g);
  if (!matches?.length) return '';
  const last = matches[matches.length - 1].replace(/\D/g, '');
  return last.length === 10 ? last : '';
}

function parsePincode(text) {
  const m = String(text || '').match(/\b([1-9]\d{5})\b/);
  return m ? m[1] : '';
}

function parseAddressAndPincode(text) {
  const pincode = parsePincode(text);
  const cleaned = String(text || '')
    .replace(/\b[6-9]\d{9}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 12 && !pincode) return { address: '', pincode: '' };
  return { address: cleaned.substring(0, 400), pincode };
}

function resolveAwb(order) {
  return String(order?.trackingNumber || order?.shiprocketOrderId || '').trim();
}

function canAutoPushToShiprocket(client) {
  if (String(client?.logisticsPartner || '').toLowerCase() !== 'shiprocket') return false;
  if (client?.rtoProtection?.enableNdrAutoPush === false) return false;
  return hasShiprocketApiCredentials(client);
}

async function setNdrFlow(convoId, flow) {
  const expiresAt = new Date(Date.now() + NDR_FLOW_TTL_MS);
  await Conversation.findByIdAndUpdate(convoId, {
    $set: {
      'metadata.ndrFlow': {
        ...flow,
        expiresAt,
        startedAt: new Date(),
      },
    },
  });
}

async function clearNdrFlow(convoId) {
  await Conversation.findByIdAndUpdate(convoId, { $unset: { 'metadata.ndrFlow': 1 } });
}

async function notifyMerchantManualNdr(client, order, reason, captured = {}) {
  try {
    const { logActivity } = require('../core/activityLogger');
    await logActivity(client.clientId, {
      type: 'ORDER',
      status: 'warning',
      title: `NDR update needs manual push — ${order.orderNumber || order.orderId}`,
      message: `${order.customerName || 'Customer'} replied on WhatsApp. ${reason}`,
      icon: 'Truck',
      url: '/orders',
      metadata: {
        orderId: String(order._id),
        shopifyOrderId: order.shopifyOrderId,
        awb: resolveAwb(order),
        ...captured,
      },
    });
  } catch (_) {
    /* non-blocking */
  }
}

async function recordNdrAction(payload) {
  return NdrAction.create(payload);
}

async function submitNdrToCourier({ client, order, action, phone, address1, address2, customerPhone }) {
  const awb = resolveAwb(order);
  const auditBase = {
    clientId: client.clientId,
    orderMongoId: order._id,
    shopifyOrderId: String(order.shopifyOrderId || ''),
    awb,
    action,
    customerPhone: customerPhone || order.customerPhone || order.phone || '',
    capturedPhone: phone || '',
    capturedAddress: address1 || '',
    capturedPincode: parsePincode(address1 || address2 || ''),
  };

  if (!awb) {
    const row = await recordNdrAction({
      ...auditBase,
      status: 'manual',
      errorMessage: 'missing_awb',
    });
    await notifyMerchantManualNdr(
      client,
      order,
      'AWB not found on order — add tracking from Shiprocket webhook first.',
      { capturedPhone: phone, capturedAddress: address1 }
    );
    return { ok: false, reason: 'missing_awb', auditId: row._id };
  }

  if (!canAutoPushToShiprocket(client)) {
    const row = await recordNdrAction({
      ...auditBase,
      status: 'manual',
      errorMessage: 'auto_push_not_configured',
    });
    await notifyMerchantManualNdr(
      client,
      order,
      'Customer details captured — add Shiprocket API credentials in Settings to auto-push.',
      { capturedPhone: phone, capturedAddress: address1 }
    );
    await Order.findByIdAndUpdate(order._id, {
      $set: {
        ndrCourierPushStatus: 'manual',
        ndrCourierPushError: 'auto_push_not_configured',
      },
    });
    return { ok: false, reason: 'manual', auditId: row._id };
  }

  try {
    const apiRes = await ndrReattempt({
      clientId: client.clientId,
      awb,
      phone,
      address1,
      address2,
    });

    await recordNdrAction({
      ...auditBase,
      status: 'success',
      shiprocketResponse: apiRes,
    });

    await Order.findByIdAndUpdate(order._id, {
      $set: {
        ndrCourierPushedAt: new Date(),
        ndrCourierPushStatus: 'success',
        ndrCourierPushError: '',
        ...(phone ? { customerPhone: phone } : {}),
        ...(address1 ? { address: address1 } : {}),
        ...(parsePincode(address1) ? { zip: parsePincode(address1) } : {}),
      },
    });

    return { ok: true, apiRes };
  } catch (err) {
    const errMsg = String(err.response?.data?.message || err.message || 'shiprocket_ndr_failed').substring(0, 500);
    await recordNdrAction({
      ...auditBase,
      status: 'failed',
      errorMessage: errMsg,
      shiprocketResponse: err.response?.data || null,
    });
    await Order.findByIdAndUpdate(order._id, {
      $set: {
        ndrCourierPushStatus: 'failed',
        ndrCourierPushError: errMsg,
      },
    });
    await notifyMerchantManualNdr(client, order, `Shiprocket API failed: ${errMsg}`, {
      capturedPhone: phone,
      capturedAddress: address1,
    });
    return { ok: false, reason: 'api_failed', error: errMsg };
  }
}

async function pushReattemptWithOrderDefaults({ client, order, customerPhone }) {
  const phone = normalizePhone(order.customerPhone || order.phone || customerPhone || '');
  const address1 = [order.address, order.city, order.state, order.zip].filter(Boolean).join(', ');
  return submitNdrToCourier({
    client,
    order,
    action: 'reattempt',
    phone,
    address1,
    address2: '',
    customerPhone,
  });
}

async function handleNdrCustomerText({ client, phone, text, convo }) {
  const flow = convo?.metadata?.ndrFlow;
  if (!flow?.orderMongoId) return false;

  if (flow.expiresAt && new Date(flow.expiresAt).getTime() < Date.now()) {
    await clearNdrFlow(convo._id);
    return false;
  }

  const order = await Order.findOne({ _id: flow.orderMongoId, clientId: client.clientId });
  const WhatsApp = require('../meta/whatsapp');
  if (!order) {
    await clearNdrFlow(convo._id);
    await WhatsApp.sendText(client, phone, 'That delivery link expired. Reply with your *order number* for help.');
    return true;
  }

  const intent = flow.intent || 'address';
  const cleanCustomer = normalizePhone(phone);

  if (intent === 'phone') {
    const mobile = parseIndianMobile(text);
    if (!mobile) {
      await WhatsApp.sendText(
        client,
        phone,
        'Please send a valid *10-digit mobile number* (e.g. 9876543210) so we can update the courier.'
      );
      return true;
    }
    const result = await submitNdrToCourier({
      client,
      order,
      action: 'phone_update',
      phone: mobile,
      address1: [order.address, order.city, order.state, order.zip].filter(Boolean).join(', '),
      customerPhone: cleanCustomer,
    });
    await clearNdrFlow(convo._id);
    const ack = result.ok
      ? `✅ Updated! We pushed your new number to the courier for order *${order.orderNumber || order.orderId}*. They will retry delivery soon.`
      : `Thanks — we received your number for order *${order.orderNumber || order.orderId}*. Our team will update the courier shortly.`;
    await WhatsApp.sendText(client, phone, ack);
    return true;
  }

  const { address, pincode } = parseAddressAndPincode(text);
  if (!address || address.length < 10) {
    await WhatsApp.sendText(
      client,
      phone,
      'Please send your *full delivery address with 6-digit pincode* in one message (e.g. Flat 12, MG Road, Bangalore 560001).'
    );
    return true;
  }

  const fullAddress = pincode && !address.includes(pincode) ? `${address} ${pincode}` : address;
  const result = await submitNdrToCourier({
    client,
    order,
    action: intent === 'reattempt' ? 'reattempt' : 'address_update',
    phone: normalizePhone(order.customerPhone || order.phone || cleanCustomer),
    address1: fullAddress,
    customerPhone: cleanCustomer,
  });
  await clearNdrFlow(convo._id);
  const ack = result.ok
    ? `✅ Address updated with the courier for order *${order.orderNumber || order.orderId}*. Delivery will be reattempted.`
    : `Thanks — we received your address for order *${order.orderNumber || order.orderId}*. Our team will sync it with the courier.`;
  await WhatsApp.sendText(client, phone, ack);
  return true;
}

module.exports = {
  parseIndianMobile,
  parsePincode,
  parseAddressAndPincode,
  resolveAwb,
  canAutoPushToShiprocket,
  setNdrFlow,
  clearNdrFlow,
  submitNdrToCourier,
  pushReattemptWithOrderDefaults,
  handleNdrCustomerText,
};
