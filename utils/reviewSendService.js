const Order = require('../models/Order');
const AdLead = require('../models/AdLead');
const ReviewRequest = require('../models/ReviewRequest');
const WhatsApp = require('./whatsapp');
const log = require('./logger')('ReviewSend');
const shopifyAdminApiVersion = require('./shopifyAdminApiVersion');

function phoneSuffixRegex(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  const suffix = clean.length >= 10 ? clean.slice(-10) : clean;
  if (!suffix) return null;
  return new RegExp(`${suffix}$`);
}

async function findLead(clientId, phone) {
  const regex = phoneSuffixRegex(phone);
  if (!regex) return null;
  return AdLead.findOne({
    clientId,
    $or: [{ phoneNumber: regex }, { phoneNumber: String(phone).trim() }],
  })
    .select('name firstName email phoneNumber')
    .lean();
}

async function findOrdersByPhone(clientId, phone, limit = 8) {
  const regex = phoneSuffixRegex(phone);
  if (!regex) return [];
  return Order.find({
    clientId,
    $or: [{ customerPhone: regex }, { phone: regex }],
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select(
      'orderId orderNumber customerName name customerPhone phone items totalPrice status createdAt shopifyOrderId'
    )
    .lean();
}

async function resolveOrder(clientId, phone, orderRef) {
  if (orderRef && orderRef !== 'MANUAL') {
    const byMongo = await Order.findOne({ clientId, _id: orderRef }).lean();
    if (byMongo) return byMongo;
    const byNum = await Order.findOne({
      clientId,
      $or: [{ orderId: String(orderRef) }, { orderNumber: String(orderRef) }],
    }).lean();
    if (byNum) return byNum;
  }
  const orders = await findOrdersByPhone(clientId, phone, 1);
  return orders[0] || null;
}

async function fetchShopifyProductImage(client, productId) {
  if (!productId) return null;
  const shopHost = (client.shopDomain || client.commerce?.shopify?.domain || '')
    .replace(/^https?:\/\//, '')
    .split('/')[0];
  const rawTok = client.shopifyAccessToken || client.commerce?.shopify?.accessToken;
  if (!shopHost || !rawTok) return null;
  try {
    const { decrypt } = require('./encryption');
    const token = decrypt(rawTok);
    const res = await require('axios').get(
      `https://${shopHost}/admin/api/${shopifyAdminApiVersion}/products/${productId}.json`,
      { headers: { 'X-Shopify-Access-Token': token }, timeout: 8000 }
    );
    return res.data?.product?.images?.[0]?.src || null;
  } catch {
    return null;
  }
}

async function resolveProductImage(client, order) {
  const item = order?.items?.[0];
  if (item?.image) return item.image;
  const pid = item?.productId;
  const fromShopify = await fetchShopifyProductImage(client, pid);
  if (fromShopify) return fromShopify;
  return client.logoUrl || client.brand?.logoUrl || null;
}

function firstNameFrom(lead, order) {
  const raw = lead?.firstName || lead?.name || order?.customerName || order?.name || 'there';
  return String(raw).trim().split(/\s+/)[0] || 'there';
}

function buildBodyVariables(syncedTemplate, ctx) {
  const body = syncedTemplate?.components?.find((c) => String(c.type).toUpperCase() === 'BODY');
  const text = body?.text || '';
  const matches = text.match(/{{(\d+)}}/g) || [];
  const paramCount =
    matches.length > 0
      ? Math.max(...matches.map((m) => parseInt(m.match(/\d+/)[0], 10)))
      : 2;

  const full = [
    ctx.firstName,
    ctx.productName,
    ctx.orderNumber,
    ctx.brandName,
    ctx.reviewUrl,
  ];

  if (paramCount >= 5) return full.slice(0, 5);
  if (paramCount >= 4) return full.slice(0, 4);
  if (paramCount >= 3) return [ctx.firstName, ctx.productName, ctx.orderNumber];
  if (paramCount >= 2) return [ctx.firstName, ctx.productName];
  return [ctx.firstName];
}

async function sendStarRatingList(client, phone, reviewId) {
  const rid = String(reviewId);
  const rows = [
    { id: `rv_star_5_${rid}`, title: '⭐⭐⭐⭐⭐ Excellent', description: '5 out of 5' },
    { id: `rv_star_4_${rid}`, title: '⭐⭐⭐⭐ Great', description: '4 out of 5' },
    { id: `rv_star_3_${rid}`, title: '⭐⭐⭐ Good', description: '3 out of 5' },
    { id: `rv_star_2_${rid}`, title: '⭐⭐ Fair', description: '2 out of 5' },
    { id: `rv_star_1_${rid}`, title: '⭐ Poor', description: '1 out of 5' },
  ];

  await WhatsApp.sendInteractive(
    client,
    phone,
    {
      type: 'list',
      header: { type: 'text', text: 'Rate your order' },
      action: {
        button: 'Choose stars',
        sections: [{ title: 'Star rating', rows }],
      },
    },
    'How would you rate your purchase? Pick a star rating below.'
  );
}

/**
 * Build context for UI preview + send pipeline.
 */
async function getReviewContext(client, phone, orderRef) {
  const { normalizePhone } = require('./helpers');
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) {
    return { success: false, message: 'Invalid phone number' };
  }

  const lead = await findLead(client.clientId, cleanPhone);
  const orders = await findOrdersByPhone(client.clientId, cleanPhone);
  const selected = (await resolveOrder(client.clientId, cleanPhone, orderRef)) || orders[0] || null;

  const firstName = firstNameFrom(lead, selected);
  const productName = selected?.items?.[0]?.name || 'your recent purchase';
  const orderNumber = selected?.orderNumber || selected?.orderId || '';
  const productImage = selected ? await resolveProductImage(client, selected) : client.logoUrl || null;
  const brandName = client.businessName || client.name || 'our store';
  const reviewUrl =
    client.brand?.googleReviewUrl ||
    client.googleReviewUrl ||
    client.platformVars?.googleReviewUrl ||
    '';

  const synced = (client.syncedMetaTemplates || []).find((t) => t.name === 'review_request');
  const templateVariables = buildBodyVariables(synced, {
    firstName,
    productName,
    orderNumber,
    brandName,
    reviewUrl,
  });

  return {
    success: true,
    phone: cleanPhone,
    customerName: lead?.name || lead?.firstName || firstName,
    orders: orders.map((o) => ({
      _id: o._id,
      orderId: o.orderId,
      orderNumber: o.orderNumber || o.orderId,
      productName: o.items?.[0]?.name || 'Order',
      productImage: o.items?.[0]?.image || null,
      totalPrice: o.totalPrice,
      status: o.status,
      createdAt: o.createdAt,
    })),
    selectedOrder: selected
      ? {
          _id: selected._id,
          orderId: selected.orderId,
          orderNumber: selected.orderNumber || selected.orderId,
          productName,
          productImage,
        }
      : null,
    preview: {
      firstName,
      productName,
      orderNumber,
      brandName,
      productImage,
      reviewUrl,
      templateVariables,
    },
  };
}

async function buildSendPayload(client, phone, order, lead, orderIdFallback) {
  const firstName = firstNameFrom(lead, order);
  const productName = order?.items?.[0]?.name || 'your recent purchase';
  const orderNumber =
    order?.orderNumber ||
    order?.orderId ||
    (orderIdFallback && orderIdFallback !== 'MANUAL' ? String(orderIdFallback) : '');
  const productImage = order ? await resolveProductImage(client, order) : client.logoUrl || null;
  const brandName = client.businessName || client.name || 'our store';
  const reviewUrl =
    client.brand?.googleReviewUrl ||
    client.googleReviewUrl ||
    client.platformVars?.googleReviewUrl ||
    '';

  const synced = (client.syncedMetaTemplates || []).find((t) => t.name === 'review_request');
  const variables = buildBodyVariables(synced, {
    firstName,
    productName,
    orderNumber,
    brandName,
    reviewUrl,
  });

  return {
    firstName,
    productName,
    orderNumber,
    productImage,
    brandName,
    reviewUrl,
    variables,
    productId: order?.items?.[0]?.productId ? String(order.items[0].productId) : '',
  };
}

async function deliverReviewMessages(client, cleanPhone, reviewReq, payload, lead) {
  const { firstName, productName, orderNumber, productImage, reviewUrl, variables } = payload;

  try {
    await WhatsApp.sendSmartTemplate(
      client,
      cleanPhone,
      'review_request',
      variables,
      productImage
    );
  } catch (waErr) {
    log.warn(`Template send failed, text fallback: ${waErr.message}`);
    const message = `Hi ${firstName}! 🌟\n\nHow was your *${productName}*${orderNumber ? ` (Order ${orderNumber})` : ''}?\n\nReply 1–5 to rate (5 = excellent).\n${reviewUrl ? `\nOr leave a review: ${reviewUrl}` : ''}`;
    await WhatsApp.sendText(client, cleanPhone, message);
  }

  try {
    await sendStarRatingList(client, cleanPhone, reviewReq._id);
  } catch (listErr) {
    log.debug(`Star list skipped (session window): ${listErr.message}`);
  }

  const customerEmail = lead?.email;
  if (customerEmail) {
    try {
      const EmailService = require('./emailService');
      await EmailService.sendReviewRequestEmail(client, {
        customerEmail,
        customerName: firstName,
        productName,
        productImage,
        reviewUrl,
      });
    } catch {
      /* optional */
    }
  }
}

/**
 * Dispatch an existing scheduled ReviewRequest document.
 */
async function dispatchExistingReviewRequest(client, reviewDoc) {
  const lead = await findLead(client.clientId, reviewDoc.phone);
  const order = await resolveOrder(client.clientId, reviewDoc.phone, reviewDoc.orderId);

  const payload = await buildSendPayload(client, reviewDoc.phone, order, lead, reviewDoc.orderId);

  if (order && !reviewDoc.productName) reviewDoc.productName = payload.productName;
  if (payload.productImage && !reviewDoc.productImage) reviewDoc.productImage = payload.productImage;
  if (payload.orderNumber && !reviewDoc.orderNumber) reviewDoc.orderNumber = payload.orderNumber;
  if (!reviewDoc.reviewUrl) reviewDoc.reviewUrl = payload.reviewUrl;

  await deliverReviewMessages(client, reviewDoc.phone, reviewDoc, payload, lead);

  reviewDoc.status = 'sent';
  reviewDoc.sentAt = new Date();
  await reviewDoc.save();

  return { reviewReq: reviewDoc, order, ...payload };
}

/**
 * Send rich review template + optional star list follow-up (manual / API).
 */
async function sendRichReviewRequest(client, { phone, orderId, orderMongoId }) {
  const { normalizePhone } = require('./helpers');
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) throw new Error('Invalid phone number format');

  const orderRef = orderMongoId || orderId;
  const order = await resolveOrder(client.clientId, cleanPhone, orderRef);
  const lead = await findLead(client.clientId, cleanPhone);
  const payload = await buildSendPayload(client, cleanPhone, order, lead, orderId);

  const reviewReq = await ReviewRequest.create({
    clientId: client.clientId,
    phone: cleanPhone,
    orderId: order?.orderId || order?.shopifyOrderId || String(orderId || 'MANUAL'),
    orderNumber: payload.orderNumber || 'Manual',
    productId: payload.productId,
    productName: payload.productName,
    productImage: payload.productImage || '',
    reviewUrl: payload.reviewUrl,
    status: 'sent',
    sentAt: new Date(),
    scheduledFor: new Date(),
  });

  await deliverReviewMessages(client, cleanPhone, reviewReq, payload, lead);

  return { reviewReq, order, variables: payload.variables, productImage: payload.productImage };
}

module.exports = {
  findOrdersByPhone,
  resolveOrder,
  resolveProductImage,
  getReviewContext,
  sendRichReviewRequest,
  dispatchExistingReviewRequest,
  buildBodyVariables,
  sendStarRatingList,
};
