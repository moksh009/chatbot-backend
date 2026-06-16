'use strict';

const mongoose = require('mongoose');
const EmailTemplate = require('../../models/EmailTemplate');
const {
  PREBUILT_ORDER_EMAIL_TEMPLATES,
  RULE_EMAIL_TEMPLATE_MAP,
} = require('../../constants/prebuiltOrderEmailTemplates');
const { buildCartItemsHtml } = require('./emailMergeFields');

const TOKEN_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function firstToken(name) {
  if (!name || !String(name).trim()) return '';
  return String(name).trim().split(/\s+/)[0] || '';
}

function formatInr(amount, currency = 'INR') {
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return '';
  if (String(currency).toUpperCase() === 'INR') return `₹${n.toLocaleString('en-IN')}`;
  return `${currency} ${n.toFixed(2)}`;
}

function buildLineItemsHtml(lineItems = []) {
  if (!Array.isArray(lineItems) || !lineItems.length) {
    return '<p style="color:#64748b;font-size:13px;">No line items available.</p>';
  }
  const rows = lineItems
    .map((item) => {
      const title = item.title || item.name || 'Item';
      const qty = item.quantity || 1;
      const price = item.price != null ? formatInr(item.price, item.currency) : '';
      return `<tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;">${title} × ${qty}</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;text-align:right;">${price}</td></tr>`;
    })
    .join('');
  return `<table style="width:100%;border-collapse:collapse;margin:12px 0;font-size:14px;color:#0f172a;">${rows}</table>`;
}

function cartTotalDisplay(lead) {
  const items = lead?.cartSnapshot?.items;
  if (!Array.isArray(items) || !items.length) return '';
  let sum = 0;
  for (const it of items) {
    const p = Number.parseFloat(it.price);
    if (!Number.isNaN(p)) sum += p * (it.quantity || 1);
  }
  if (sum <= 0) return '';
  return sum.toLocaleString('en-IN');
}

function buildCartItemsText(lead) {
  const items = lead?.cartSnapshot?.items;
  if (!Array.isArray(items) || !items.length) return '';
  return items.map((it) => `${it.title || it.name || 'Item'} × ${it.quantity || 1}`).join(', ');
}

function storeUrl(client) {
  const domain = client?.shopDomain || client?.shopifyDomain || '';
  if (!domain) return '';
  const host = String(domain).replace(/^https?:\/\//, '').split('/')[0];
  return host ? `https://${host}` : '';
}

function primaryFulfillment(payload = {}) {
  const list = payload.fulfillments || [];
  return list[0] || {};
}

function refundAmountDisplay(payload = {}) {
  const refunds = payload.refunds || [];
  let sum = 0;
  for (const r of refunds) {
    for (const tx of r.transactions || []) {
      const amt = Number.parseFloat(tx.amount);
      if (Number.isFinite(amt)) sum += amt;
    }
  }
  if (sum <= 0 && payload.total_refunded) {
    sum = Number.parseFloat(payload.total_refunded);
  }
  return sum > 0 ? formatInr(sum, payload.currency || 'INR') : '';
}

/**
 * Flat merge context for order-status transactional emails.
 */
function buildOrderEmailContext(payload = {}, lead = null, client = null) {
  const cust = payload.customer || {};
  const ship = payload.shipping_address || payload.billing_address || {};
  const fulfillment = primaryFulfillment(payload);
  const storeName = client?.name || client?.brand?.businessName || 'Our store';
  const orderNumberRaw = payload.name || payload.order_number || payload.id || '';
  const orderNumber = String(orderNumberRaw).startsWith('#')
    ? String(orderNumberRaw)
    : orderNumberRaw
      ? `#${orderNumberRaw}`
      : '';

  return {
    first_name: firstToken(cust.first_name || lead?.name || ship.first_name),
    name:
      [cust.first_name, cust.last_name].filter(Boolean).join(' ') ||
      lead?.name ||
      'Customer',
    email: lead?.email || cust.email || '',
    phone: lead?.phoneNumber || cust.phone || payload.phone || '',
    order_id: String(payload.id || payload.order_id || ''),
    order_number: orderNumber,
    order_total: formatInr(payload.total_price, payload.currency || 'INR'),
    order_currency: payload.currency || 'INR',
    store_name: storeName,
    store_url: storeUrl(client),
    tracking_number: fulfillment.tracking_number || '',
    tracking_url: fulfillment.tracking_url || (Array.isArray(fulfillment.tracking_urls) && fulfillment.tracking_urls[0]) || '',
    carrier: fulfillment.tracking_company || fulfillment.tracking_company_name || '',
    estimated_delivery: fulfillment.estimated_delivery_at || '',
    fulfillment_status: payload.fulfillment_status || '',
    financial_status: payload.financial_status || '',
    refund_amount: refundAmountDisplay(payload),
    cart_items: buildCartItemsText(lead),
    cart_total: cartTotalDisplay(lead) || formatInr(payload.total_price, payload.currency || 'INR'),
    cart_recovery_url: lead?.checkoutUrl || lead?.abandonedCheckoutUrl || '#',
    line_items_html: buildLineItemsHtml(payload.line_items || []),
    cart_items_html: buildCartItemsHtml(lead),
  };
}

function buildCartEmailContext(lead, client, stepNum = 1, recoveryUrl = '') {
  const ctx = buildOrderEmailContext({}, lead, client);
  ctx.cart_recovery_url =
    recoveryUrl || lead?.checkoutUrl || lead?.abandonedCheckoutUrl || ctx.cart_recovery_url;
  ctx.cart_items_html = buildCartItemsHtml(lead);
  ctx.cart_total = cartTotalDisplay(lead) || ctx.cart_total;
  ctx.step = String(stepNum);
  return ctx;
}

function applyMergeContext(subject, html, context = {}) {
  function apply(str) {
    if (!str) return '';
    return String(str).replace(TOKEN_RE, (_full, inner) => {
      const key = String(inner || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '_');
      const val = context[key];
      return val == null ? '' : String(val);
    });
  }
  return { subject: apply(subject), html: apply(html) };
}

async function resolveOrderEmailTemplate({ rule, clientId, context = {} }) {
  const ec = rule?.emailConfig || {};
  let subject = String(ec.subject || '').trim();
  let html = String(ec.bodyHtml || '').trim();
  const templateKey =
    String(ec.templateId || '').trim() || RULE_EMAIL_TEMPLATE_MAP[rule?.id] || '';

  if ((!subject || !html) && templateKey) {
    const prebuilt = PREBUILT_ORDER_EMAIL_TEMPLATES[templateKey];
    if (prebuilt) {
      if (!subject) subject = prebuilt.subject;
      if (!html) html = prebuilt.bodyHtml;
    } else if (mongoose.Types.ObjectId.isValid(templateKey)) {
      const row = await EmailTemplate.findOne({ clientId, _id: templateKey, isActive: true })
        .select('subject bodyHtml')
        .lean();
      if (row) {
        if (!subject) subject = row.subject;
        if (!html) html = row.bodyHtml;
      }
    } else {
      const row = await EmailTemplate.findOne({
        clientId,
        legacyLocalId: templateKey,
        isActive: true,
      })
        .select('subject bodyHtml')
        .lean();
      if (row) {
        if (!subject) subject = row.subject;
        if (!html) html = row.bodyHtml;
      }
    }
  }

  if (!subject || !html) {
    return { ok: false, reason: 'missing_email_template' };
  }

  const merged = applyMergeContext(subject, html, context);
  return {
    ok: true,
    subject: merged.subject,
    html: merged.html,
    templateKey,
  };
}

function ruleHasEmailConfig(rule) {
  const ec = rule?.emailConfig;
  if (ec?.subject && ec?.bodyHtml) return true;
  if (ec?.templateId) return true;
  return !!RULE_EMAIL_TEMPLATE_MAP[rule?.id];
}

function normalizeRuleChannels(rule) {
  const raw = Array.isArray(rule?.channels) ? rule.channels : ['whatsapp'];
  const out = [...new Set(raw.map((c) => String(c).toLowerCase()).filter((c) => c === 'whatsapp' || c === 'email'))];
  return out.length ? out : ['whatsapp'];
}

/** Sample order context for dashboard test sends (Order messages / email hub). */
function buildOrderEmailTestSampleContext(client = null, recipientEmail = '') {
  return buildOrderEmailContext(
    {
      name: '#TE-1042',
      id: '6104293847291',
      total_price: '6499.00',
      currency: 'INR',
      financial_status: 'paid',
      fulfillment_status: 'unfulfilled',
      customer: {
        first_name: 'Rahul',
        last_name: 'Kumar',
        email: recipientEmail || 'customer@example.com',
      },
      line_items: [
        { title: 'Classic Cotton Hoodie', quantity: 1, price: '1499.00' },
        { title: 'Everyday Joggers', quantity: 1, price: '999.00' },
      ],
      fulfillments: [
        {
          tracking_number: 'DLV8829104567',
          tracking_url: 'https://track.example.com/p/ABC123',
          tracking_company: 'Delhivery',
        },
      ],
    },
    recipientEmail ? { name: 'Rahul Kumar', email: recipientEmail } : null,
    client
  );
}

module.exports = {
  buildOrderEmailContext,
  buildCartEmailContext,
  buildOrderEmailTestSampleContext,
  applyMergeContext,
  resolveOrderEmailTemplate,
  ruleHasEmailConfig,
  normalizeRuleChannels,
  buildLineItemsHtml,
};
