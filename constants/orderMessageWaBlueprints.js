/**
 * WhatsApp utility blueprints for order/shipment automations (preview + studio).
 * Keep in sync with chatbot-backend-main/constants/orderMessageWaBlueprints.js
 */
const ORDER_MESSAGE_WA_BLUEPRINTS = {
  order_in_transit: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}! 📦 Your order {{2}} is on the way.\n\n' +
          'Track your package live here:\n{{3}}',
        example: { body_text: [['Priya', '#1042', 'https://track.example.com/AWB12345']] },
      },
    ],
  },
  order_out_for_delivery: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}! 🚚 Your order {{2}} is out for delivery and should reach you today.\n\n' +
          'Please keep your phone reachable for the delivery agent.',
        example: { body_text: [['Priya', '#1042']] },
      },
    ],
  },
  order_delivered_update: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}! ✅ Your order {{2}} has been delivered.\n\n' +
          'We hope you love it — reply here if anything is not right and we will sort it out.',
        example: { body_text: [['Priya', '#1042']] },
      },
    ],
  },
  delivery_attempt_failed: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}, the courier tried to deliver your order {{2}} today but could not complete the delivery.\n\n' +
          'Please reply with a good time to deliver, or share an alternate phone number / address so we can re-attempt it.',
        example: { body_text: [['Priya', '#1042']] },
      },
    ],
  },
  rto_ndr_rescue: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}}, we could not complete delivery for order *{{2}}*.\n\n' +
          'Please reply in this chat with a *10-digit mobile number* or your *full address and PIN code* so we can try again.\n\n' +
          'Reference: {{3}}',
        example: { body_text: [['Priya', '#1042', '5678901234']] },
      },
    ],
  },
  order_confirmation_v1: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: ['https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400'] },
        _imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
      },
      {
        type: 'BODY',
        text:
          'Hi {{1}}! 🎉 Your order is confirmed!\n\n' +
          'Order ID: {{2}}\nProduct: {{3}}\nTotal: {{4}}\nDelivery to: {{5}}\n\n' +
          "We'll notify you when your order ships. Need help? Tap *Contact support*.",
        example: { body_text: [['Priya', '#TE-1042', 'Linen co-ord set', '₹2,499', 'Mumbai 400001']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Track order' },
          { type: 'QUICK_REPLY', text: 'Contact support' },
        ],
      },
    ],
  },
  order_cancellation_v1: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'BODY',
        text:
          'Hi {{1}},\n\nYour cancellation request for Order *{{2}}* has been received.\n\n' +
          'If eligible, your refund of *{{3}}* will be credited within 5–7 business days.\n\n' +
          'We hope to see you again at {{4}}!',
        example: { body_text: [['Priya', '#TE-1042', '₹2,499', 'Your store']] },
      },
    ],
  },
  abandoned_cart_r1_v1: {
    category: 'MARKETING',
    language: 'en',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: ['https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400'] },
        _imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
      },
      {
        type: 'BODY',
        text:
          'Hi {{1}}! 👋\n\nYour *{{2}}* is ready for checkout — total *₹{{3}}*.\n\n' +
          'Tap *Buy now* to complete your order in one step. Questions? Tap *Contact support* and our team will help.',
        example: { body_text: [['Priya', 'Linen co-ord set', '2,499']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Buy now', url: 'https://checkout.example.com/cart' },
          { type: 'QUICK_REPLY', text: 'Contact support' },
        ],
      },
    ],
  },
  abandoned_cart_r2_v1: {
    category: 'MARKETING',
    language: 'en',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: ['https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400'] },
        _imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
      },
      {
        type: 'BODY',
        text:
          "Hi {{1}}, still thinking about *{{2}}*? 🔥\n\nYour cart is saved but popular items sell out fast. Secure yours before they're gone — tap *Buy now* below.",
        example: { body_text: [['Priya', 'Linen co-ord set']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Buy now', url: 'https://checkout.example.com/cart' },
          { type: 'QUICK_REPLY', text: 'Contact support' },
        ],
      },
    ],
  },
  abandoned_cart_r3_v1: {
    category: 'MARKETING',
    language: 'en',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: ['https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400'] },
        _imageUrl: 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400',
      },
      {
        type: 'BODY',
        text:
          'Hi {{1}}, last call for *{{2}}* (₹{{3}})!\n\nUse code *{{4}}* at checkout for 10% off. Offer ends soon — tap *Buy now* to claim it 👇',
        example: { body_text: [['Priya', 'Linen co-ord set', '2,499', 'COMEBACK10']] },
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'URL', text: 'Buy now', url: 'https://checkout.example.com/cart' },
          { type: 'QUICK_REPLY', text: 'Contact support' },
        ],
      },
    ],
  },
  eco_order_confirmed: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: ['https://images.unsplash.com/photo-1549465220-1a8b9238cd48?w=400'] },
        _imageUrl: 'https://images.unsplash.com/photo-1549465220-1a8b9238cd48?w=400',
      },
      {
        type: 'BODY',
        text:
          '🎉 *Order confirmed!*\n\nHi {{1}}, thanks for shopping with us!\n\nOrder *#{{2}}* for *{{3}}* is being prepared. 📦\n\n' +
          'Payment: {{4}}\n\nWe\'ll notify you when it ships. Tap *Contact support* if you need help.',
        example: { body_text: [['Priya', 'TE-1042', '₹2,499', 'Prepaid']] },
      },
      { type: 'FOOTER', text: "Reply 'STOP' to opt-out." },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Track order' },
          { type: 'QUICK_REPLY', text: 'Contact support' },
        ],
      },
    ],
  },
  eco_shipping_update: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: ['https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=400'] },
        _imageUrl: 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=400',
      },
      {
        type: 'BODY',
        text:
          '🚚 *Your order has shipped!*\n\nHi {{1}}! Order *#{{2}}* is on the way. 🚀\n\nTrack your package here:\n{{3}}\n\nNeed help? Tap *Contact support* below.',
        example: { body_text: [['Priya', 'TE-1042', 'https://track.example.com/AWB12345']] },
      },
      { type: 'FOOTER', text: "Reply 'STOP' to opt-out." },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Track order' },
          { type: 'QUICK_REPLY', text: 'Contact support' },
        ],
      },
    ],
  },
  eco_delivered: {
    category: 'UTILITY',
    language: 'en',
    components: [
      {
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_handle: ['https://images.unsplash.com/photo-1531206715517-5c0ba140b2b8?w=400'] },
        _imageUrl: 'https://images.unsplash.com/photo-1531206715517-5c0ba140b2b8?w=400',
      },
      {
        type: 'BODY',
        text:
          '✅ *Delivered!*\n\nHi {{1}}, your order *#{{2}}* has been delivered. We hope you love it!\n\nReply here if anything needs fixing.',
        example: { body_text: [['Priya', 'TE-1042']] },
      },
      { type: 'FOOTER', text: "Reply 'STOP' to opt-out." },
    ],
  },
};

const BLUEPRINT_ALIASES = {
  cart_recovery_1: 'abandoned_cart_r1_v1',
  cart_recovery_2: 'abandoned_cart_r2_v1',
  cart_recovery_3: 'abandoned_cart_r3_v1',
};

function getOrderMessageBlueprint(nameOrKey) {
  const key = String(nameOrKey || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_');
  const resolved = BLUEPRINT_ALIASES[key] || key;
  if (!resolved || !ORDER_MESSAGE_WA_BLUEPRINTS[resolved]) return null;
  return { name: resolved, ...ORDER_MESSAGE_WA_BLUEPRINTS[resolved] };
}

module.exports = {
  ORDER_MESSAGE_WA_BLUEPRINTS,
  getOrderMessageBlueprint,
};
