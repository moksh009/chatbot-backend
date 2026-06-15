'use strict';

/**
 * Prebuilt transactional email templates for order status + cart recovery automations.
 * Keys referenced by commerce rule `emailConfig.templateId` or RULE_EMAIL_TEMPLATE_MAP.
 * Rich HTML bodies live in `orderAutomationEmailHtml.js` — keep in sync with frontend.
 */
const ORDER_AUTOMATION_EMAIL_HTML = require('./orderAutomationEmailHtml');

const PREBUILT_ORDER_EMAIL_TEMPLATES = {
  order_confirmed: {
    name: 'Order confirmed',
    category: 'order',
    subject: 'Your order {{order_number}} is confirmed! ✅',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.order_confirmed,
  },
  order_partial_fulfillment: {
    name: 'Partial fulfillment',
    category: 'order',
    subject: 'Part of your order has shipped 📦',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.order_partial_fulfillment,
  },
  order_shipped: {
    name: 'Order shipped',
    category: 'order',
    subject: 'Your order is on its way! 🚚',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.order_shipped,
  },
  order_in_transit: {
    name: 'In transit',
    category: 'order',
    subject: 'Your package is in transit',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.order_in_transit,
  },
  order_out_for_delivery: {
    name: 'Out for delivery',
    category: 'order',
    subject: 'Out for delivery today! 🏠',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.order_out_for_delivery,
  },
  order_delivered: {
    name: 'Delivered',
    category: 'order',
    subject: 'Your order has been delivered 🎉',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.order_delivered,
  },
  order_delivery_failed: {
    name: 'Delivery attempt failed',
    category: 'order',
    subject: 'Delivery attempt unsuccessful',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.order_delivery_failed,
  },
  order_cancelled: {
    name: 'Order cancelled',
    category: 'order',
    subject: 'Your order {{order_number}} has been cancelled',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.order_cancelled,
  },
  order_refunded: {
    name: 'Full refund',
    category: 'order',
    subject: 'Refund of {{refund_amount}} processed',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.order_refunded,
  },
  order_partial_refund: {
    name: 'Partial refund',
    category: 'order',
    subject: 'Partial refund of {{refund_amount}} processed',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.order_partial_refund,
  },
  cart_recovery_email_1: {
    name: 'Cart recovery — reminder',
    category: 'cart_recovery',
    subject: 'Hey {{first_name}}, you left something behind!',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.cart_recovery_email_1,
  },
  cart_recovery_email_2: {
    name: 'Cart recovery — 5% off',
    category: 'cart_recovery',
    subject: "Still thinking? Here's 5% off just for you",
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.cart_recovery_email_2,
  },
  cart_recovery_email_3: {
    name: 'Cart recovery — last chance',
    category: 'cart_recovery',
    subject: 'Last chance — your cart expires at midnight',
    bodyHtml: ORDER_AUTOMATION_EMAIL_HTML.cart_recovery_email_3,
  },
};

/** Default prebuilt key per system commerce rule id. */
const RULE_EMAIL_TEMPLATE_MAP = {
  sys_financial_paid: 'order_confirmed',
  sys_fulfillment_partial: 'order_partial_fulfillment',
  sys_fulfillment_fulfilled: 'order_shipped',
  sys_shipment_in_transit: 'order_in_transit',
  sys_shipment_out_for_delivery: 'order_out_for_delivery',
  sys_shipment_delivered: 'order_delivered',
  sys_shipment_attempted_delivery: 'order_delivery_failed',
  sys_shipment_failure: 'order_delivery_failed',
  sys_financial_voided: 'order_cancelled',
  sys_financial_refunded: 'order_refunded',
  sys_financial_partially_refunded: 'order_partial_refund',
  sys_cart_followup_1: 'cart_recovery_email_1',
  sys_cart_followup_2: 'cart_recovery_email_2',
  sys_cart_followup_3: 'cart_recovery_email_3',
};

function defaultEmailConfigForRule(ruleId) {
  const templateId = RULE_EMAIL_TEMPLATE_MAP[ruleId];
  if (!templateId) return null;
  return {
    templateId,
    subject: '',
    bodyHtml: '',
    variableMappings: {},
    sendWhen: 'always',
  };
}

module.exports = {
  PREBUILT_ORDER_EMAIL_TEMPLATES,
  RULE_EMAIL_TEMPLATE_MAP,
  defaultEmailConfigForRule,
};
