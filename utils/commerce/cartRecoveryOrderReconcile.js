'use strict';

const Client = require('../../models/Client');
const Order = require('../../models/Order');
const AdLead = require('../../models/AdLead');
const { normalizePhoneWithCountry } = require('../core/helpers');
const { normalizeEmail } = require('./marketingConsent');
const { handleOrderAtomic } = require('../shopify/handleOrderAtomic');
const { indianPhoneSuffix } = require('../core/normalizeIndianPhone');
const {
  extractShopifyOrderPhoneRaw,
  extractShopifyOrderEmail,
  extractCheckoutToken,
  resolveShopifyOrderContact,
} = require('./resolveShopifyOrderContact');
const log = require('../core/logger')('CartRecoveryReconcile');

function normalizePhoneSuffix(raw) {
  return indianPhoneSuffix(raw);
}

function isCancelledOrRefundedOrder(data) {
  if (data?.cancelled_at) return true;
  const fin = String(data?.financial_status || data?.financialStatus || '').toLowerCase();
  const st = String(data?.status || '').toLowerCase();
  if (fin === 'refunded' || fin === 'voided') return true;
  if (st === 'refunded' || st === 'cancelled') return true;
  return false;
}

function abandonTimestamp(lead) {
  return (
    lead?.cartAbandonedAt ||
    lead?.contactCapturedAt ||
    lead?.checkoutInitiatedAt ||
    lead?.lastCartEventAt ||
    lead?.createdAt ||
    null
  );
}

/**
 * True when a stored Order row completes an abandon that is not yet marked recovered.
 */
function orderRecoversAbandonedLead(order, lead) {
  if (!order || !lead) return false;
  if (lead.isOrderPlaced === true) return false;
  if (['recovered', 'purchased'].includes(String(lead.cartStatus || ''))) return false;
  if (isCancelledOrRefundedOrder(order)) return false;

  const abandonAt = abandonTimestamp(lead);
  if (!abandonAt) return false;

  const orderAt = order.createdAt ? new Date(order.createdAt) : null;
  if (!orderAt) return false;

  return orderAt.getTime() >= new Date(abandonAt).getTime() - 2 * 60 * 1000;
}

function shopifyPayloadFromOrder(order, lead = null) {
  const phoneRaw = order.customerPhone || order.phone || lead?.phoneNumber || '';
  const shopifyId = order.shopifyOrderId || String(order.orderId || '').replace(/^#/, '');
  return {
    id: shopifyId || order._id,
    name: order.orderId || order.orderNumber || shopifyId,
    created_at: order.createdAt || new Date(),
    total_price: String(order.totalPrice ?? order.amount ?? 0),
    phone: phoneRaw,
    email: order.customerEmail || order.email || lead?.email,
    financial_status: order.financialStatus || 'paid',
    checkout_token: order.checkoutToken || lead?.checkoutToken || undefined,
    cart_token: lead?.cartToken || undefined,
  };
}

/**
 * Mark matching abandoned-cart lead recovered when a Shopify order is known.
 * Safe to call from webhooks, pixel, Shopify sync, and workspace/cron reconcile.
 */
async function reconcileCartRecoveryFromShopifyOrder(client, orderPayload, options = {}) {
  if (!client?.clientId || !orderPayload) {
    return { skipped: true, reason: 'missing_input' };
  }
  if (isCancelledOrRefundedOrder(orderPayload)) {
    return { skipped: true, reason: 'cancelled_or_refunded' };
  }

  const contact = resolveShopifyOrderContact(client, orderPayload);
  if (!contact.canProcess) {
    return { skipped: true, reason: 'no_contact_keys' };
  }

  try {
    const result = await handleOrderAtomic(client, orderPayload, contact.cleanPhone || '');
    return {
      skipped: false,
      duplicate: !!result.duplicate,
      matched: !!result.recoveryMatched,
      leadId: result.lead?._id ? String(result.lead._id) : null,
      cartStatus: result.lead?.cartStatus || null,
      matchVia: contact.matchVia,
      source: options.source || 'reconcile',
    };
  } catch (err) {
    log.warn(
      `[CartRecoveryReconcile] order ${orderPayload.id || orderPayload.name}: ${err.message}`
    );
    return { skipped: false, error: err.message };
  }
}

function buildLeadIndexes(openLeads) {
  const byPhone = new Map();
  const byEmail = new Map();
  const byCheckoutToken = new Map();

  for (const lead of openLeads) {
    const phoneKey = normalizePhoneSuffix(lead.phoneNumber);
    if (phoneKey.length >= 8 && !byPhone.has(phoneKey)) byPhone.set(phoneKey, lead);

    const emailKey = normalizeEmail(lead.email);
    if (emailKey && !byEmail.has(emailKey)) byEmail.set(emailKey, lead);

    const token = String(lead.checkoutToken || '').trim();
    if (token && !byCheckoutToken.has(token)) byCheckoutToken.set(token, lead);
  }

  return { byPhone, byEmail, byCheckoutToken };
}

function pickLeadForOrder(order, indexes) {
  const phoneKey = normalizePhoneSuffix(order.customerPhone || order.phone);
  if (phoneKey.length >= 8 && indexes.byPhone.has(phoneKey)) {
    return { lead: indexes.byPhone.get(phoneKey), via: 'phone' };
  }

  const emailKey = normalizeEmail(order.customerEmail || order.email);
  if (emailKey && indexes.byEmail.has(emailKey)) {
    return { lead: indexes.byEmail.get(emailKey), via: 'email' };
  }

  const token = String(order.checkoutToken || '').trim();
  if (token && indexes.byCheckoutToken.has(token)) {
    return { lead: indexes.byCheckoutToken.get(token), via: 'checkout_token' };
  }

  return { lead: null, via: null };
}

/**
 * Backfill: open abandoned leads matched by phone, email, or checkout token
 * against stored Order rows (common when webhooks miss localhost / dev tunnels).
 */
async function reconcileOpenCartLeadsForClient(clientId, options = {}) {
  const client = await Client.findOne({ clientId }).lean();
  if (!client) return { reconciled: 0, checked: 0, skipped: true };

  const since = options.since instanceof Date ? options.since : new Date(Date.now() - 90 * 86400000);
  const maxLeads = Math.min(Number(options.maxLeads) || 300, 500);

  const openLeads = await AdLead.find({
    clientId,
    isOrderPlaced: { $ne: true },
    cartStatus: { $in: ['abandoned', 'active', 'checkout_started'] },
    $or: [{ cartAbandonedAt: { $gte: since } }, { updatedAt: { $gte: since } }],
  })
    .select(
      'phoneNumber email checkoutToken cartToken cartAbandonedAt contactCapturedAt checkoutInitiatedAt lastCartEventAt createdAt'
    )
    .limit(maxLeads)
    .lean();

  if (!openLeads.length) return { reconciled: 0, checked: 0 };

  const indexes = buildLeadIndexes(openLeads);
  const hasAnyKey =
    indexes.byPhone.size > 0 || indexes.byEmail.size > 0 || indexes.byCheckoutToken.size > 0;
  if (!hasAnyKey) return { reconciled: 0, checked: openLeads.length };

  const orders = await Order.find({
    clientId,
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .limit(800)
    .lean();

  let reconciled = 0;
  const processedOrderIds = new Set();
  const consumedLeadIds = new Set();

  for (const order of orders) {
    const orderKey = order.shopifyOrderId || order.orderId || String(order._id);
    if (processedOrderIds.has(orderKey)) continue;

    const { lead, via } = pickLeadForOrder(order, indexes);
    if (!lead || consumedLeadIds.has(String(lead._id))) continue;
    if (!orderRecoversAbandonedLead(order, lead)) continue;

    const payload = shopifyPayloadFromOrder(order, lead);
    const out = await reconcileCartRecoveryFromShopifyOrder(client, payload, {
      source: `open_lead_reconcile:${via}`,
    });

    if (out.matched && !out.duplicate && !out.error) {
      reconciled += 1;
      consumedLeadIds.add(String(lead._id));
      if (via === 'phone') indexes.byPhone.delete(normalizePhoneSuffix(lead.phoneNumber));
      if (via === 'email') indexes.byEmail.delete(normalizeEmail(lead.email));
      if (via === 'checkout_token') indexes.byCheckoutToken.delete(String(lead.checkoutToken || '').trim());
    }
    processedOrderIds.add(orderKey);
  }

  return { reconciled, checked: openLeads.length };
}

module.exports = {
  extractShopifyOrderPhoneRaw,
  extractShopifyOrderEmail,
  extractCheckoutToken,
  resolveShopifyOrderContact,
  isCancelledOrRefundedOrder,
  orderRecoversAbandonedLead,
  reconcileCartRecoveryFromShopifyOrder,
  reconcileOpenCartLeadsForClient,
  shopifyPayloadFromOrder,
  buildLeadIndexes,
  pickLeadForOrder,
};
