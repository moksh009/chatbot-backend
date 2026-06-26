'use strict';

/** SSOT labels for cart recovery attribution (not email — organic = returned checkout). */

const RECOVERY_BREAKDOWN_KEYS = {
  WHATSAPP: 'abandoned_cart_whatsapp',
  CHECKOUT: 'abandoned_cart_checkout',
  MARKETING: 'marketing',
  COD_PREPAID: 'cod_prepaid',
};

function pluralCheckout(count) {
  const n = Number(count) || 0;
  if (n === 1) return '1 shopper returned & purchased';
  if (n > 1) return `${n} returned checkouts`;
  return null;
}

function pluralWhatsappCarts(count) {
  const n = Number(count) || 0;
  if (n === 1) return '1 cart via WhatsApp';
  if (n > 1) return `${n} carts via WhatsApp`;
  return null;
}

function buildCartRecoveryBreakdownRows({
  whatsappRevenueInr = 0,
  whatsappRecovered = 0,
  checkoutRevenueInr = 0,
  checkoutRecovered = 0,
  marketingRevenueInr = 0,
  marketingOrders = 0,
  codRevenueInr = 0,
  codCount = 0,
} = {}) {
  const rows = [
    {
      key: RECOVERY_BREAKDOWN_KEYS.WHATSAPP,
      label: 'Abandoned cart · WhatsApp',
      revenueInr: Math.round(Number(whatsappRevenueInr) || 0),
      meta: pluralWhatsappCarts(whatsappRecovered),
    },
    {
      key: RECOVERY_BREAKDOWN_KEYS.CHECKOUT,
      label: 'Abandoned cart · Checkout',
      revenueInr: Math.round(Number(checkoutRevenueInr) || 0),
      meta: pluralCheckout(checkoutRecovered),
    },
    {
      key: RECOVERY_BREAKDOWN_KEYS.MARKETING,
      label: 'Marketing campaigns',
      revenueInr: Math.round(Number(marketingRevenueInr) || 0),
      meta: marketingOrders
        ? `${marketingOrders} attributed order${marketingOrders === 1 ? '' : 's'}`
        : null,
    },
  ];

  if (Math.round(Number(codRevenueInr) || 0) > 0) {
    rows.push({
      key: RECOVERY_BREAKDOWN_KEYS.COD_PREPAID,
      label: 'COD → prepaid',
      revenueInr: Math.round(Number(codRevenueInr) || 0),
      meta: codCount ? `${codCount} conversion${codCount === 1 ? '' : 's'}` : null,
    });
  }

  return rows;
}

module.exports = {
  RECOVERY_BREAKDOWN_KEYS,
  pluralCheckout,
  pluralWhatsappCarts,
  buildCartRecoveryBreakdownRows,
};
