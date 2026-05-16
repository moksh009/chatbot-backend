'use strict';

/**
 * RTO Protection Suite — prevention (COD confirm) + intervention (NDR rescue).
 * Toggles live on Client.rtoProtection; metrics on Order.* fields.
 */

const axios = require('axios');
const Order = require('../models/Order');
const Client = require('../models/Client');
const shopifyAdminApiVersion = require('./shopifyAdminApiVersion');
const { normalizePhone } = require('./helpers');
const { trackEcommerceEvent } = require('./analyticsHelper');

function rtoCfg(client) {
  const rp = client?.rtoProtection || {};
  return {
    requireCodConfirmation: !!rp.requireCodConfirmation,
    enableNdrRescue: !!rp.enableNdrRescue,
    codConfirmationHours: Math.max(6, Math.min(72, Number(rp.codConfirmationHours) || 24)),
    estimatedRtoCostPerOrder: Math.max(200, Math.min(5000, Number(rp.estimatedRtoCostPerOrder) || 800)),
    ndrTemplateName: String(rp.ndrTemplateName || 'rto_ndr_rescue').trim() || 'rto_ndr_rescue',
    ndrTemplateLanguage: String(rp.ndrTemplateLanguage || 'en').trim() || 'en',
  };
}

async function sendInteractive(client, phone, bodyText, buttons) {
  const WhatsApp = require('./whatsapp');
  const interactive = {
    type: 'button',
    body: { text: bodyText.substring(0, 1024) },
    action: {
      buttons: buttons.map((b) => ({
        type: 'reply',
        reply: { id: b.id, title: String(b.title).substring(0, 20) },
      })),
    },
  };
  await WhatsApp.sendInteractive(client, phone, interactive, bodyText);
}

/**
 * After a new COD Shopify order is persisted, optionally send confirmation tap.
 */
async function maybeSendCodConfirmationAfterOrderCreate(client, orderDoc) {
  const cfg = rtoCfg(client);
  if (!cfg.requireCodConfirmation) return { skipped: true, reason: 'disabled' };
  if (!orderDoc?.isCOD) return { skipped: true, reason: 'not_cod' };
  const phone = orderDoc.customerPhone || orderDoc.phone;
  if (!phone) return { skipped: true, reason: 'no_phone' };

  const cutoff = new Date(Date.now() - 120000);
  const claim = await Order.findOneAndUpdate(
    {
      _id: orderDoc._id,
      clientId: client.clientId,
      isCOD: true,
      $and: [
        { $or: [{ codConfirmationSentAt: null }, { codConfirmationSentAt: { $exists: false } }] },
        {
          $or: [
            { codConfirmationProcessingAt: null },
            { codConfirmationProcessingAt: { $exists: false } },
            { codConfirmationProcessingAt: { $lt: cutoff } },
          ],
        },
      ],
    },
    { $set: { codConfirmationProcessingAt: new Date() } },
    { new: true }
  );
  if (!claim) return { skipped: true, reason: 'already_sent_or_inflight' };

  const clean = normalizePhone(phone);
  const oid = String(orderDoc._id);
  const body =
    `Hi ${orderDoc.customerName || 'there'}! 👋\n\n` +
    `We received your COD order *${orderDoc.orderNumber || orderDoc.orderId}* (₹${orderDoc.totalPrice || orderDoc.amount || 0}).\n\n` +
    `Please *confirm* so we can prepare your shipment, or *cancel* if this wasn’t you (saves everyone time & delivery cost).\n\n` +
    `_You have ${cfg.codConfirmationHours}h to respond._`;

  try {
    await sendInteractive(client, clean, body, [
      { id: `rto_cod_confirm_${oid}`, title: '✅ Confirm order' },
      { id: `rto_cod_cancel_${oid}`, title: '❌ Cancel' },
    ]);
    const deadline = new Date(Date.now() + cfg.codConfirmationHours * 3600000);
    await Order.findByIdAndUpdate(orderDoc._id, {
      $set: {
        codConfirmationSentAt: new Date(),
        codConfirmationResponse: 'pending',
        codConfirmationDeadlineAt: deadline,
        rtoStatus: 'at_risk',
      },
      $unset: { codConfirmationProcessingAt: 1 },
    });
    return { ok: true };
  } catch (e) {
    console.error('[RTOProtection] COD confirm send failed:', e.message);
    await Order.findByIdAndUpdate(orderDoc._id, { $unset: { codConfirmationProcessingAt: 1 } }).catch(() => {});
    return { ok: false, error: e.message };
  }
}

async function cancelOrderInShopify(client, shopifyOrderId) {
  if (!client.shopDomain || !client.shopifyAccessToken || !shopifyOrderId) {
    return { ok: false, reason: 'no_shopify' };
  }
  try {
    const base = `https://${client.shopDomain}/admin/api/${shopifyAdminApiVersion}`;
    await axios.post(
      `${base}/orders/${shopifyOrderId}/cancel.json`,
      { reason: 'customer' },
      { headers: { 'X-Shopify-Access-Token': client.shopifyAccessToken, 'Content-Type': 'application/json' } }
    );
    return { ok: true };
  } catch (e) {
    const detail = e.response?.data || e.message;
    const errStr = typeof detail === 'string' ? detail : JSON.stringify(detail);
    console.error('[RTOProtection] Shopify cancel failed:', errStr);
    return { ok: false, error: errStr.substring(0, 800) };
  }
}

async function handleCodConfirmationButton({ client, phone, buttonId }) {
  const cfg = rtoCfg(client);
  if (!cfg.requireCodConfirmation) return false;

  let orderId = null;
  let action = null;
  if (buttonId.startsWith('rto_cod_confirm_')) {
    action = 'confirm';
    orderId = buttonId.replace('rto_cod_confirm_', '');
  } else if (buttonId.startsWith('rto_cod_cancel_')) {
    action = 'cancel';
    orderId = buttonId.replace('rto_cod_cancel_', '');
  } else return false;

  if (!orderId) return false;
  const order = await Order.findOne({ _id: orderId, clientId: client.clientId });
  const WhatsApp = require('./whatsapp');
  if (!order) {
    await WhatsApp.sendText(client, phone, 'That order link is no longer valid. If you need help, reply *menu*.');
    return true;
  }

  if (action === 'confirm') {
    order.isCodConfirmed = true;
    order.codConfirmationResponse = 'confirmed';
    order.codConfirmationRespondedAt = new Date();
    order.rtoStatus = 'safe';
    await order.save();
    await WhatsApp.sendText(
      client,
      phone,
      `✅ Thanks! Your order *${order.orderNumber || order.orderId}* is confirmed. We’ll keep you posted on WhatsApp.`
    );
    await trackEcommerceEvent(client.clientId, { rtoCodConfirmed: 1 }).catch(() => {});
    return true;
  }

  let shopifyRes = { ok: true };
  if (order.shopifyOrderId) {
    shopifyRes = await cancelOrderInShopify(client, order.shopifyOrderId);
  }

  const cancelled = await Order.findOneAndUpdate(
    {
      _id: order._id,
      clientId: client.clientId,
      codConfirmationResponse: { $nin: ['cancelled'] },
    },
    {
      $set: {
        codConfirmationResponse: 'cancelled',
        codConfirmationRespondedAt: new Date(),
        rtoStatus: 'returned',
        status: 'cancelled',
        shopifyCancelError: shopifyRes.ok ? '' : String(shopifyRes.error || shopifyRes.reason || 'shopify_cancel_failed').substring(0, 500),
      },
    },
    { new: true }
  );

  if (!cancelled) {
    await WhatsApp.sendText(client, phone, 'This order was already cancelled. If you need help, reply *menu*.');
    return true;
  }

  const ack =
    shopifyRes.ok || !order.shopifyOrderId
      ? `Your order *${order.orderNumber || order.orderId}* has been cancelled as requested.`
      : `We’ve cancelled this request on our side. Our team will sync with the store for order *${order.orderNumber || order.orderId}* — reply *menu* if you still see it as open.`;
  await WhatsApp.sendText(client, phone, ack);

  const est = rtoCfg(client).estimatedRtoCostPerOrder;
  await Order.findByIdAndUpdate(cancelled._id, { $inc: { rtoValueAttributed: est } }).catch(() => {});
  await trackEcommerceEvent(client.clientId, { rtoCostSaved: est, rtoFakeCodBlocked: 1 }).catch(() => {});
  return true;
}

const NDR_SHIPMENT_TRIGGERS = new Set(['failure', 'attempted_delivery', 'delayed']);

async function maybeSendNdrRescueFromFulfillment(client, fulfillment, io) {
  const cfg = rtoCfg(client);
  if (!cfg.enableNdrRescue) return { skipped: true, reason: 'disabled' };

  const orderId = fulfillment?.order_id;
  if (!orderId) return { skipped: true, reason: 'no_order_id' };
  const oidStr = String(orderId);

  const shipmentStatus = String(
    fulfillment.shipment_status || fulfillment.status || ''
  ).toLowerCase();

  if (!NDR_SHIPMENT_TRIGGERS.has(shipmentStatus)) {
    return { skipped: true, reason: 'shipment_ok', shipmentStatus };
  }

  const pre = await Order.findOne({ clientId: client.clientId, shopifyOrderId: oidStr }).select('_id').lean();
  if (!pre) return { skipped: true, reason: 'no_local_order' };

  const cutoff = new Date(Date.now() - 120000);
  const claimed = await Order.findOneAndUpdate(
    {
      clientId: client.clientId,
      shopifyOrderId: oidStr,
      $and: [
        { $or: [{ ndrRescueSentAt: null }, { ndrRescueSentAt: { $exists: false } }] },
        {
          $or: [
            { ndrRescueProcessingAt: null },
            { ndrRescueProcessingAt: { $exists: false } },
            { ndrRescueProcessingAt: { $lt: cutoff } },
          ],
        },
      ],
    },
    {
      $set: {
        ndrRescueProcessingAt: new Date(),
        lastNdrEventAt: new Date(),
        rtoStatus: 'at_risk',
        fulfillmentStatus: shipmentStatus || 'in_transit',
      },
      $inc: { deliveryAttempts: 1 },
    },
    { new: true }
  );

  if (!claimed) return { skipped: true, reason: 'ndr_already_sent_or_inflight' };

  const phone = claimed.customerPhone || claimed.phone;
  if (!phone) {
    await Order.findByIdAndUpdate(claimed._id, {
      $unset: { ndrRescueProcessingAt: 1 },
      $inc: { deliveryAttempts: -1 },
    }).catch(() => {});
    return { skipped: true, reason: 'no_phone' };
  }

  const clean = normalizePhone(phone);
  const orderLabel = claimed.orderNumber || claimed.orderId || oidStr;
  const shopifyRef = String(claimed.shopifyOrderId || oidStr);
  const customerName = claimed.customerName || 'there';
  const WhatsApp = require('./whatsapp');
  const tpl = cfg.ndrTemplateName;
  const lang = cfg.ndrTemplateLanguage;

  try {
    await WhatsApp.sendSmartTemplate(
      client,
      clean,
      tpl,
      [customerName, orderLabel, shopifyRef],
      null,
      lang,
      { disableSessionFallback: true }
    );

    const updated = await Order.findByIdAndUpdate(
      claimed._id,
      {
        $set: { ndrRescueSentAt: new Date() },
        $unset: { ndrRescueProcessingAt: 1 },
      },
      { new: true }
    );
    if (io && updated) {
      io.to(`client_${client.clientId}`).emit('order_updated', updated.toObject());
    }
    await trackEcommerceEvent(client.clientId, { rtoNdrRescuesSent: 1 }).catch(() => {});
    return { ok: true };
  } catch (e) {
    console.error('[RTOProtection] NDR rescue send failed:', e.message);
    await Order.findByIdAndUpdate(claimed._id, {
      $unset: { ndrRescueProcessingAt: 1 },
      $inc: { deliveryAttempts: -1 },
    }).catch(() => {});
    return { ok: false, error: e.message };
  }
}

async function handleNdrRescueButton({ client, phone, buttonId }) {
  if (!buttonId.startsWith('rto_ndr_alt_') && !buttonId.startsWith('rto_ndr_addr_')) return false;
  const oid = buttonId.replace(/^rto_ndr_(alt|addr)_/, '');
  const order = await Order.findOne({ _id: oid, clientId: client.clientId });
  const WhatsApp = require('./whatsapp');
  if (!order) {
    await WhatsApp.sendText(client, phone, 'We could not find that delivery. Please reply with your *order number*.');
    return true;
  }
  await WhatsApp.sendText(
    client,
    phone,
    `Thanks! Order ref: *${order.orderNumber || order.orderId}*. Send your *10-digit phone* or *full address + pincode* in one message so our team can update the courier.`
  );
  return true;
}

async function aggregateRtoProtectionStats(clientId, clientLean) {
  const client = clientLean || (await Client.findOne({ clientId }).lean());
  const cfg = rtoCfg(client || {});
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const base = { clientId, createdAt: { $gte: monthStart } };

  const [
    codVerifiedCount,
    ndrRescueSentCount,
    prepaidFromCodCount,
    fakeCodCancelledCount,
    deliveredAfterNdrCount,
  ] = await Promise.all([
    Order.countDocuments({ ...base, isCodConfirmed: true }),
    Order.countDocuments({ ...base, ndrRescueSentAt: { $ne: null } }),
    Order.countDocuments({
      ...base,
      paidViaLink: true,
      codNudgeSentAt: { $ne: null },
    }),
    Order.countDocuments({ ...base, codConfirmationResponse: 'cancelled' }),
    Order.countDocuments({
      ...base,
      ndrRescueSentAt: { $ne: null },
      $or: [{ status: 'delivered' }, { status: 'Delivered' }],
    }),
  ]);

  const avg = cfg.estimatedRtoCostPerOrder;
  const revenueRecovered = Math.round(
    prepaidFromCodCount * avg * 0.85 +
      fakeCodCancelledCount * avg +
      deliveredAfterNdrCount * avg * 0.5 +
      codVerifiedCount * avg * 0.1
  );

  const ordersShielded = codVerifiedCount + prepaidFromCodCount + fakeCodCancelledCount + ndrRescueSentCount;

  const tips = [];
  const totalCodMonth = await Order.countDocuments({ ...base, isCOD: true });
  if (totalCodMonth > 5 && fakeCodCancelledCount / totalCodMonth < 0.02) {
    tips.push('Very few COD cancellations after confirmation — keep COD confirmation on for new orders.');
  }
  if (
    totalCodMonth > 3 &&
    prepaidFromCodCount / totalCodMonth < 0.08 &&
    (client?.wizardFeatures?.enableCodToPrepaid || client?.wizardFeatures?.codDiscountAmount)
  ) {
    const d = client?.wizardFeatures?.codDiscountAmount || 50;
    tips.push(`COD→prepaid uptake looks soft. Try raising the instant discount to ₹${Math.min(150, d + 25)} in Wizard → COD → Prepaid.`);
  }
  if (ndrRescueSentCount > 0 && deliveredAfterNdrCount / ndrRescueSentCount < 0.25) {
    tips.push('Several NDR rescues fired but few deliveries closed — follow up manually on those threads.');
  }
  if (tips.length === 0) {
    tips.push(
      'RTO Protection runs in the background: COD confirmation cuts fake orders; NDR rescue helps couriers complete delivery.'
    );
  }

  return {
    success: true,
    protectionActive: !!(cfg.requireCodConfirmation || cfg.enableNdrRescue),
    toggles: {
      requireCodConfirmation: cfg.requireCodConfirmation,
      enableNdrRescue: cfg.enableNdrRescue,
      codConfirmationHours: cfg.codConfirmationHours,
      estimatedRtoCostPerOrder: cfg.estimatedRtoCostPerOrder,
      ndrTemplateName: cfg.ndrTemplateName,
      ndrTemplateLanguage: cfg.ndrTemplateLanguage,
    },
    month: {
      start: monthStart.toISOString(),
      codOrdersVerified: codVerifiedCount,
      ordersShielded,
      revenueRecovered,
      ndrRescueSent: ndrRescueSentCount,
      prepaidConversionsAttributed: prepaidFromCodCount,
      fakeCodCancelled: fakeCodCancelledCount,
      deliveredAfterNdr: deliveredAfterNdrCount,
    },
    tips,
  };
}

/**
 * Flow Builder COD buttons (cod_yes / cod_no) — sync Order record when customer taps in-chat.
 */
async function handleFlowCodButton({ client, phone, buttonId }) {
  if (buttonId !== 'cod_yes' && buttonId !== 'cod_no') return false;

  const Conversation = require('../models/Conversation');
  const convo = await Conversation.findOne({ phone, clientId: client.clientId }).lean();
  const last = convo?.metadata?.lastOrder || {};
  const orClauses = [];
  if (last._id) orClauses.push({ _id: last._id });
  if (last.orderId) orClauses.push({ orderId: String(last.orderId) });
  if (last.shopifyOrderId) orClauses.push({ shopifyOrderId: String(last.shopifyOrderId) });
  if (!orClauses.length) return false;

  const order = await Order.findOne({ clientId: client.clientId, $or: orClauses });
  if (!order || !order.isCOD) return false;

  const WhatsApp = require('./whatsapp');
  if (buttonId === 'cod_yes') {
    order.isCodConfirmed = true;
    order.codConfirmationResponse = 'confirmed';
    order.codConfirmationRespondedAt = new Date();
    order.rtoStatus = 'safe';
    await order.save();
    await trackEcommerceEvent(client.clientId, { rtoCodConfirmed: 1 }).catch(() => {});
    return true;
  }

  let shopifyRes = { ok: true };
  if (order.shopifyOrderId) {
    shopifyRes = await cancelOrderInShopify(client, order.shopifyOrderId);
  }
  order.codConfirmationResponse = 'cancelled';
  order.codConfirmationRespondedAt = new Date();
  order.rtoStatus = 'returned';
  order.status = 'cancelled';
  order.shopifyCancelError = shopifyRes.ok ? '' : String(shopifyRes.error || 'shopify_cancel_failed').substring(0, 500);
  await order.save();
  await WhatsApp.sendText(
    client,
    phone,
    `Your order *${order.orderNumber || order.orderId}* has been cancelled as requested.`
  );
  await trackEcommerceEvent(client.clientId, { rtoFakeCodBlocked: 1 }).catch(() => {});
  return true;
}

/**
 * Notify merchant when COD confirmation is still pending past deadline.
 */
async function processCodConfirmationTimeouts(io) {
  const now = new Date();
  const overdue = await Order.find({
    codConfirmationResponse: 'pending',
    codConfirmationSentAt: { $ne: null },
    codConfirmationDeadlineAt: { $lte: now },
  })
    .limit(40)
    .lean();

  const { logActivity } = require('./activityLogger');

  for (const order of overdue) {
    const claimed = await Order.findOneAndUpdate(
      {
        _id: order._id,
        clientId: order.clientId,
        codConfirmationResponse: 'pending',
      },
      { $set: { codConfirmationResponse: 'expired', rtoStatus: 'at_risk' } },
      { new: true }
    );
    if (!claimed) continue;

    const client = await Client.findOne({ clientId: order.clientId }).lean();
    if (!client) continue;

    const title = `COD not confirmed — ${order.orderNumber || order.orderId}`;
    const message = `${order.customerName || 'Customer'} (${order.customerPhone || '—'}) has not confirmed COD order within the window.`;

    await logActivity(order.clientId, {
      type: 'ORDER',
      status: 'warning',
      title,
      message,
      icon: 'AlertTriangle',
      url: '/orders',
      metadata: { orderId: String(order._id), shopifyOrderId: order.shopifyOrderId },
    }).catch(() => {});

    if (io) {
      io.to(`client_${order.clientId}`).emit('admin_alert', {
        topic: title,
        message,
        phone: order.customerPhone,
        leadName: order.customerName,
      });
    }
  }

  return { processed: overdue.length };
}

module.exports = {
  rtoCfg,
  NDR_SHIPMENT_TRIGGERS,
  maybeSendCodConfirmationAfterOrderCreate,
  handleCodConfirmationButton,
  handleFlowCodButton,
  processCodConfirmationTimeouts,
  maybeSendNdrRescueFromFulfillment,
  handleNdrRescueButton,
  aggregateRtoProtectionStats,
  cancelOrderInShopify,
};
