"use strict";

/**
 * Standard Ecommerce Templates for Meta Cloud API
 * Prefixed with eco_ for easy identification.
 * All include an IMAGE header and a FOOTER.
 *
 * `eco_shipping_update` pairs with order status automation: map it under
 * Settings → Order status → **shipped** (nicheData.orderStatusTemplates.shipped).
 * Body {{1}}–{{3}} match sendMappedOrderStatusWhatsApp (name, order #, tracking URL).
 */
const STANDARD_TEMPLATES = [
  {
    id: 'eco_order_confirmed',
    name: 'eco_order_confirmed',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: [ "https://images.unsplash.com/photo-1549465220-1a8b9238cd48" ] }
      },
      {
        type: 'BODY',
        text: "🎉 *Order confirmed!*\n\nHi {{1}}, thanks for shopping with us!\n\nOrder *#{{2}}* for *{{3}}* is being prepared. 📦\n\nPayment: {{4}}\n\nWe'll notify you when it ships. Tap *Contact support* if you need help.",
        example: { body_text: [ ["Customer", "10294", "₹2,450", "Prepaid"] ] }
      },
      {
        type: 'FOOTER',
        text: "Reply 'STOP' to opt-out."
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Track order' },
          { type: 'QUICK_REPLY', text: 'Contact support' }
        ]
      }
    ],
    variableMapping: {
      1: 'Customer Name',
      2: 'Order ID',
      3: 'Order Total',
      4: 'Payment Method'
    }
  },
  {
    id: 'eco_shipping_update',
    name: 'eco_shipping_update',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: [ "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d" ] }
      },
      {
        type: 'BODY',
        text: "🚚 *Your order has shipped!*\n\nHi {{1}}! Order *#{{2}}* is on the way. 🚀\n\nTrack your package here:\n{{3}}\n\nNeed help? Tap *Contact support* below.",
        example: { body_text: [ ["Customer", "10294", "https://track.it/ABC123XYZ"] ] }
      },
      {
        type: 'FOOTER',
        text: "Reply 'STOP' to opt-out."
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Track order' },
          { type: 'QUICK_REPLY', text: 'Contact support' }
        ]
      }
    ],
    variableMapping: {
      1: 'Customer Name',
      2: 'Order ID',
      3: 'Tracking URL'
    }
  },
  {
    id: 'eco_delivered',
    name: 'eco_delivered',
    category: 'UTILITY',
    language: 'en_US',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: [ "https://images.unsplash.com/photo-1531206715517-5c0ba140b2b8" ] }
      },
      {
        type: 'BODY',
        text: "✅ *Order delivered!*\n\nHi {{1}}, your order *#{{2}}* has been delivered! 🎁\n\nWe hope you love your purchase. Share a photo and tag us! 📸\n\nSomething wrong? Tap *Contact support*.",
        example: { body_text: [ ["Customer", "10294"] ] }
      },
      {
        type: 'FOOTER',
        text: "Reply 'STOP' to opt-out."
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Leave a review' },
          { type: 'QUICK_REPLY', text: 'Contact support' }
        ]
      }
    ],
    variableMapping: {
      1: 'Customer Name',
      2: 'Order ID'
    }
  },
  {
    id: 'eco_cod_prepaid_switch',
    name: 'eco_cod_prepaid_switch',
    category: 'MARKETING',
    language: 'en_US',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: [ 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?auto=format&fit=crop&q=80&w=900' ] }
      },
      {
        type: 'BODY',
        text: "💳 *Save on your order!*\n\nHi {{1}} 👋\n\nYour order *#{{2}}* for *{{3}}* ({{4}}) is confirmed as COD.\n\n🎁 *Pay via UPI right now and get:*\n✅ {{5}}\n✅ {{6}}\n\n⏰ *Offer expires in {{7}}!*\n\nWe prioritise prepaid orders for dispatch — tap a button below.",
        example: { body_text: [[
          'Moksh',
          '1030',
          'Smart Video Doorbell Plus (3MP)',
          '₹6,499',
          '₹50 cashback',
          'Priority shipping',
          '2 hours'
        ]] }
      },
      {
        type: 'FOOTER',
        text: "Reply STOP to opt out of marketing."
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: '💳 Pay via UPI Now' },
          { type: 'QUICK_REPLY', text: 'Keep COD' }
        ]
      }
    ],
    variableMapping: {
      1: 'Customer first name',
      2: 'Order number',
      3: 'Product line',
      4: 'Order total (formatted)',
      5: 'Incentive 1 (e.g. cashback)',
      6: 'Incentive 2 (e.g. shipping)',
      7: 'Urgency window'
    }
  }
];

const { validateEcoStandardPack } = require("./templateCatalog");

const _ecoValidation = validateEcoStandardPack(STANDARD_TEMPLATES);
if (!_ecoValidation.ok && process.env.NODE_ENV !== "production") {
  // eslint-disable-next-line no-console
  console.warn(
    "[standardTemplates] drift vs template-catalog.json",
    { missing: _ecoValidation.missing, extra: _ecoValidation.extra }
  );
}

module.exports = { STANDARD_TEMPLATES };
