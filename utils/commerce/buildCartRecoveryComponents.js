'use strict';

const { buildRecoveryUrl } = require('./buildRecoveryUrl');
const { buildCartRecoveryBodyParameters } = require('../../constants/cartRecoverySlotPresets');

function firstCartItem(lead = {}) {
  const snap = lead.cartSnapshot || {};
  const items = Array.isArray(snap.items) ? snap.items : Array.isArray(lead.cartItems) ? lead.cartItems : [];
  return items[0] || null;
}

function resolveCartRecoveryContext(lead = {}, client = {}, stepNum = 1) {
  const item = firstCartItem(lead);
  const snap = lead.cartSnapshot || {};
  const nameParts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
  const customerName =
    lead.firstName ||
    nameParts[0] ||
    lead.name ||
    (lead.phoneNumber && !/^unknown_/i.test(String(lead.phoneNumber)) ? lead.phoneNumber : 'there');
  const productName =
    item?.title ||
    item?.name ||
    item?.productName ||
    item?.product_title ||
    'items in your cart';
  let productImage = item?.image || item?.image_url || item?.imageUrl || null;
  if (productImage && !String(productImage).startsWith('https')) productImage = null;

  const cartTotalRaw =
    lead.cartValue ??
    snap.total_price ??
    snap.totalPrice ??
    item?.price ??
    '';
  const cartTotal = cartTotalRaw !== '' && cartTotalRaw != null ? String(cartTotalRaw) : '';

  const storeHost = client.shopDomain
    ? String(client.shopDomain).replace(/^https?:\/\//, '').split('/')[0]
    : '';
  const token = lead.checkoutToken || snap.checkoutToken || '';
  const recoverFromToken =
    storeHost && token ? `https://${storeHost}/cart/recover/${token}` : '';
  const baseUrl =
    lead.checkoutUrl ||
    snap.checkoutUrl ||
    lead.cartUrl ||
    lead.abandoned_checkout_url ||
    recoverFromToken ||
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
  };
}

/**
 * Build Meta Cloud API components for cart recovery templates.
 * @param {object} lead
 * @param {object} client
 * @param {number} stepNum 1|2|3
 * @param {{ includeHeaderImage?: boolean, discountCode?: string }} opts
 */
function buildCartRecoveryComponents(lead, client, stepNum = 1, opts = {}) {
  const ctx = resolveCartRecoveryContext(lead, client, stepNum);
  if (opts.recoveryUrl) ctx.recoveryUrl = String(opts.recoveryUrl).slice(0, 2000);
  const discountCode = opts.discountCode || ctx.discountCode || '';
  const includeImage = opts.includeHeaderImage !== false && stepNum !== 2;
  const components = [];

  if (includeImage && ctx.productImage) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: String(ctx.productImage).slice(0, 2048) } }],
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
};
