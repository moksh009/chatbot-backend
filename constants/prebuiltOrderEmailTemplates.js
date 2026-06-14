'use strict';

/**
 * Prebuilt transactional email templates for order status + cart recovery automations.
 * Keys referenced by commerce rule `emailConfig.templateId` or RULE_EMAIL_TEMPLATE_MAP.
 */
const PREBUILT_ORDER_EMAIL_TEMPLATES = {
  order_confirmed: {
    name: 'Order confirmed',
    category: 'order',
    subject: 'Your order {{order_number}} is confirmed! ✅',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>Thank you for shopping with {{store_name}}!</p><p>Your order <strong>{{order_number}}</strong> is confirmed.</p><p>Order total: <strong>{{order_total}}</strong></p>{{line_items_html}}<p>We will notify you when it ships.</p>',
  },
  order_partial_fulfillment: {
    name: 'Partial fulfillment',
    category: 'order',
    subject: 'Part of your order has shipped 📦',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>Good news — part of your order {{order_number}} from {{store_name}} has shipped.</p>{{line_items_html}}<p>Track your shipment: {{tracking_url}}</p>',
  },
  order_shipped: {
    name: 'Order shipped',
    category: 'order',
    subject: 'Your order is on its way! 🚚',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>Your order {{order_number}} has shipped.</p><p>Carrier: {{carrier}}<br/>Tracking: {{tracking_number}}</p><p><a href="{{tracking_url}}">Track your package</a></p>',
  },
  order_in_transit: {
    name: 'In transit',
    category: 'order',
    subject: 'Your package is in transit',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>Your order {{order_number}} is in transit with {{carrier}}.</p><p>Tracking: {{tracking_number}}</p><p><a href="{{tracking_url}}">Track delivery</a></p>',
  },
  order_out_for_delivery: {
    name: 'Out for delivery',
    category: 'order',
    subject: 'Out for delivery today! 🏠',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>Your package from {{store_name}} is out for delivery today.</p><p>Tracking: {{tracking_number}}</p><p><a href="{{tracking_url}}">Track live status</a></p>',
  },
  order_delivered: {
    name: 'Delivered',
    category: 'order',
    subject: 'Your order has been delivered 🎉',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>Your order {{order_number}} was delivered. We hope you love it!</p><p>Need help? Reply to this email or visit {{store_url}}</p>',
  },
  order_delivery_failed: {
    name: 'Delivery attempt failed',
    category: 'order',
    subject: 'Delivery attempt unsuccessful',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>We tried delivering your order {{order_number}} but could not complete it.</p><p>Please confirm your address or availability so we can reattempt delivery.</p>',
  },
  order_cancelled: {
    name: 'Order cancelled',
    category: 'order',
    subject: 'Your order {{order_number}} has been cancelled',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>Your order {{order_number}} at {{store_name}} has been cancelled.</p><p>If you did not request this, contact us at {{store_url}}</p>',
  },
  order_refunded: {
    name: 'Full refund',
    category: 'order',
    subject: 'Refund of {{refund_amount}} processed',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>A refund of <strong>{{refund_amount}}</strong> for order {{order_number}} has been processed.</p><p>It may take 5–7 business days to reflect in your account.</p>',
  },
  order_partial_refund: {
    name: 'Partial refund',
    category: 'order',
    subject: 'Partial refund of {{refund_amount}} processed',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>A partial refund of <strong>{{refund_amount}}</strong> for order {{order_number}} has been processed.</p>',
  },
  cart_recovery_email_1: {
    name: 'Cart recovery — reminder',
    category: 'cart_recovery',
    subject: 'Hey {{first_name}}, you left something behind!',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>Your cart at {{store_name}} is still waiting:</p>{{cart_items_html}}<p>Total: {{cart_total}}</p><p><a href="{{cart_recovery_url}}">Complete your order</a></p>',
  },
  cart_recovery_email_2: {
    name: 'Cart recovery — 5% off',
    category: 'cart_recovery',
    subject: "Still thinking? Here's 5% off just for you",
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>We saved your cart — take <strong>5% off</strong> with code <strong>CART5</strong>.</p>{{cart_items_html}}<p><a href="{{cart_recovery_url}}">Checkout now</a></p>',
  },
  cart_recovery_email_3: {
    name: 'Cart recovery — last chance',
    category: 'cart_recovery',
    subject: 'Last chance — your cart expires at midnight',
    bodyHtml:
      '<p>Hi {{first_name}},</p><p>Final reminder before your saved items at {{store_name}} expire.</p>{{cart_items_html}}<p><a href="{{cart_recovery_url}}">Complete order before midnight</a></p>',
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
