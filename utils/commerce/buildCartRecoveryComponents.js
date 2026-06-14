'use strict';

const { buildRecoveryUrl, buildLeadRecoveryBaseUrl, buildLeadRecoveryUrl } = require('./buildRecoveryUrl');
const { buildCartRecoveryBodyParameters } = require('../../constants/cartRecoverySlotPresets');

function cartLineItems(lead = {}) {
  const snap = lead.cartSnapshot || {};
  if (Array.isArray(snap.items) && snap.items.length) return snap.items;
  if (Array.isArray(lead.cartItems) && lead.cartItems.length) return lead.cartItems;
  return [];
}

function lineItemValue(item = {}) {
  const qty = Number(item.quantity || item.qty || 1) || 1;
  const lineTotal = Number(item.lineTotal);
  if (Number.isFinite(lineTotal) && lineTotal > 0) return lineTotal;
  const price = Number(item.price ?? item.productPrice ?? item.line_price ?? 0);
  if (Number.isFinite(price) && price > 0) return price * qty;
  return 0;
}

/** Pick highest cart line value; ties keep first max. */
function pickBestCartItem(lead = {}) {
  const items = cartLineItems(lead);
  if (!items.length) return null;
  return items.reduce((best, item) => {
    if (!best) return item;
    return lineItemValue(item) >= lineItemValue(best) ? item : best;
  }, null);
}

function firstCartItem(lead = {}) {
  return pickBestCartItem(lead) || cartLineItems(lead)[0] || null;
}

function formatCartTotalINR(raw) {
  const n = Number(String(raw || '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) {
    const s = String(raw || '').trim();
    return s || '—';
  }
  return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function resolveHttpsImage(url) {
  const s = String(url || '').trim();
  if (!s.startsWith('https://')) return null;
  return s.slice(0, 2048);
}

function resolveProductImage(item, client = {}) {
  const fromItem = resolveHttpsImage(
    item?.image || item?.image_url || item?.imageUrl || item?.featured_image?.src
  );
  if (fromItem) return fromItem;
  const brand =
    client?.businessLogo ||
    client?.nicheData?.businessLogo ||
    client?.brand?.logoUrl ||
    null;
  return resolveHttpsImage(brand);
}

function resolveCartRecoveryContext(lead = {}, client = {}, stepNum = 1) {
  const item = pickBestCartItem(lead);
  const snap = lead.cartSnapshot || {};
  const nameParts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
  const customerName =
    lead.firstName ||
    nameParts[0] ||
    lead.name ||
    (lead.phoneNumber && !/^unknown_/i.test(String(lead.phoneNumber)) ? lead.phoneNumber : 'there');

  const items = cartLineItems(lead);
  const productName =
    item?.title ||
    item?.name ||
    item?.productName ||
    item?.product_title ||
    (items.length > 1 ? `${items.length} items in your cart` : 'items in your cart');

  const productImage = resolveProductImage(item, client);

  const cartTotalRaw =
    lead.cartValue ??
    snap.total_price ??
    snap.totalPrice ??
    snap.cartValue ??
    (items.length ? items.reduce((s, i) => s + lineItemValue(i), 0) : '') ??
    '';
  const cartTotal = formatCartTotalINR(cartTotalRaw);

  const baseUrl =
    buildLeadRecoveryBaseUrl(client, lead) ||
    lead.checkoutUrl ||
    snap.checkoutUrl ||
    lead.cartUrl ||
    lead.abandoned_checkout_url ||
    '';
  const recoveryUrl = buildRecoveryUrl(baseUrl, stepNum);
  const discountCode = lead.lastDiscountCode || lead.discountCode || '';

  return {
    customerName: String(customerName).slice(0, 256),
    productName: String(productName).slice(0, 256),
    productImage,
    cartTotal,
    recoveryUrl,
    discountCode,
    itemCount: items.length,
  };
}

/**
 * Build Meta Cloud API components for cart recovery templates.
 * @param {object} lead
 * @param {object} client
 * @param {number} stepNum 1|2|3
 * @param {{ includeHeaderImage?: boolean, discountCode?: string, recoveryUrl?: string }} opts
 */
function buildCartRecoveryComponents(lead, client, stepNum = 1, opts = {}) {
  const ctx = resolveCartRecoveryContext(lead, client, stepNum);
  if (opts.recoveryUrl) ctx.recoveryUrl = String(opts.recoveryUrl).slice(0, 2000);
  const discountCode = opts.discountCode || ctx.discountCode || '';
  const includeImage = opts.includeHeaderImage !== false;
  const components = [];

  if (includeImage && ctx.productImage) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: ctx.productImage } }],
    });
  }

  let bodyParams;
  if (stepNum === 2) {
    bodyParams = buildCartRecoveryBodyParameters(stepNum, ctx);
  } else if (stepNum === 3) {
    bodyParams = buildCartRecoveryBodyParameters(stepNum, ctx, { discountCode });
  } else {
    bodyParams = buildCartRecoveryBodyParameters(1, ctx);
  }
  components.push({ type: 'body', parameters: bodyParams });

  if (ctx.recoveryUrl) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: ctx.recoveryUrl.slice(0, 2000) }],
    });
  }

  return { components, context: ctx };
}

module.exports = {
  buildCartRecoveryComponents,
  resolveCartRecoveryContext,
  firstCartItem,
  pickBestCartItem,
  formatCartTotalINR,
  lineItemValue,
};
