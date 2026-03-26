/**
 * Phase 9 – Default Flow Node Graphs
 * 
 * Returns the initial {nodes, edges} React Flow DAG for a given business type.
 * These are persisted in MongoDB (Client.flowNodes / Client.flowEdges) and
 * rendered in the dashboard Visual Flow Builder.
 * 
 * Niche keys: 'ecommerce' | 'salon' | 'clinic' | 'turf' | 'other'
 */

const Y_SPACING = 200;
const X_CENTER = 350;

// ─── shared helper ────────────────────────────────────────────────────────────
function node(id, type, label, subtext, x, y, extra = {}) {
  return {
    id,
    type,
    position: { x, y },
    data: { label, subtext, ...extra }
  };
}
function edge(id, source, target, label = '') {
  return { id, source, target, label, animated: true };
}

// =============================================================================
// 1. ECOMMERCE (Delitech-style / Generic eCommerce)
// =============================================================================
function getEcommerceFlow() {
  const nodes = [
    node('trigger',      'trigger',     'Hi / Hello / QR Scan',         'User sends greeting or scans QR code',                               X_CENTER, 0),
    node('welcome',      'interactive', 'Welcome Message',               '🛍️ "Welcome to our store! How can we help you today?" + buttons',    X_CENTER - 200, Y_SPACING),
    node('catalog',      'message',     'Product Catalog',               '📦 Shows product images with descriptions and buy links',             X_CENTER - 200, Y_SPACING * 2),
    node('order_form',   'message',     'Order / Checkout',              '🛒 Collects customer name, address, and payment choice (COD/UPI)',    X_CENTER - 200, Y_SPACING * 3),
    node('order_confirm','message',     'Order Confirmed',               '✅ "Your order #{orderId} has been placed! Shipping in 2-3 days."',   X_CENTER - 200, Y_SPACING * 4),
    node('support',      'interactive', 'Support / FAQ',                 '❓ Answers common questions via AI / pre-set replies',                X_CENTER + 200, Y_SPACING * 2),
    node('agent_hand',   'message',     'Live Agent Handover',           '👤 "Connecting you to our support team..."',                          X_CENTER + 200, Y_SPACING * 3),
    node('abandon_cart', 'message',     'Abandoned Cart Recovery',       '⏰ Triggered 2 hr after cart add | COD-to-Prepaid nudge',             X_CENTER + 400, Y_SPACING * 2),
  ];
  const edges = [
    edge('e1', 'trigger',     'welcome',       ''),
    edge('e2', 'welcome',     'catalog',       '🛍️ Shop Now'),
    edge('e3', 'welcome',     'support',       '❓ Support'),
    edge('e4', 'catalog',     'order_form',    '✅ Add to Cart'),
    edge('e5', 'order_form',  'order_confirm', '📦 Place Order'),
    edge('e6', 'support',     'agent_hand',    '🧑 Speak to Agent'),
  ];
  return { nodes, edges };
}

// =============================================================================
// 2. SALON / CLINIC (Choice Salon-style)
// =============================================================================
function getSalonFlow() {
  const nodes = [
    node('trigger',      'trigger',     'Hi / Hello',                    'User sends greeting',                                                X_CENTER, 0),
    node('welcome',      'interactive', 'Welcome Message',               '💅 "Welcome! Choose an option:" + Book / FAQ buttons',               X_CENTER,       Y_SPACING),
    node('services',     'interactive', 'Services & Pricing',            '💇 Show service list with prices via list message',                  X_CENTER - 250, Y_SPACING * 2),
    node('book_flow',    'message',     'Open Booking Flow',             '📅 Opens Meta WhatsApp Flow for selecting service/date/time',        X_CENTER - 250, Y_SPACING * 3),
    node('pending',      'interactive', 'Pending Confirmation',          '⏳ "Confirm your booking?" + Confirm/Cancel buttons',                X_CENTER - 250, Y_SPACING * 4),
    node('confirmed',    'message',     'Booking Confirmed',             '✅ DB saved + Google Calendar event created + Admin notified',        X_CENTER - 250, Y_SPACING * 5),
    node('faq',          'interactive', 'FAQ Topics',                    '❓ Pick a topic: Services / Pricing / Booking / Other',              X_CENTER + 200, Y_SPACING * 2),
    node('faq_reply',    'message',     'AI FAQ Reply',                  '🤖 Gemini AI generates a context-aware answer',                      X_CENTER + 200, Y_SPACING * 3),
    node('upsell',       'interactive', 'Upsell / Cross-sell',          '💎 After booking: "Add Mirror Shine Botosmooth?" + Yes/No',          X_CENTER + 50,  Y_SPACING * 5.5),
    node('agent_hand',   'message',     'Live Agent Handover',           '👤 "Connecting you to our team..."',                                 X_CENTER + 200, Y_SPACING * 4),
  ];
  const edges = [
    edge('e1', 'trigger',   'welcome',   ''),
    edge('e2', 'welcome',   'services',  '📋 Services'),
    edge('e3', 'welcome',   'faq',       '❓ Ask Question'),
    edge('e4', 'services',  'book_flow', '📅 Book Now'),
    edge('e5', 'book_flow', 'pending',   '📋 Form Submitted'),
    edge('e6', 'pending',   'confirmed', '✅ User Confirms'),
    edge('e7', 'confirmed', 'upsell',    '💎 Upsell'),
    edge('e8', 'faq',       'faq_reply', '💬 Topic Selected'),
    edge('e9', 'faq_reply', 'agent_hand','🧑 Still Need Help'),
  ];
  return { nodes, edges };
}

// =============================================================================
// 3. TURF
// =============================================================================
function getTurfFlow() {
  const nodes = [
    node('trigger',   'trigger',     'Hi / Hello',          'User sends greeting',                               X_CENTER, 0),
    node('welcome',   'interactive', 'Welcome Message',     '⚽ "Welcome! Book a turf or ask a question:"',      X_CENTER, Y_SPACING),
    node('book',      'message',     'Booking Form',        '📅 Collects date, time, number of players',         X_CENTER - 200, Y_SPACING * 2),
    node('confirm',   'message',     'Booking Confirmed',   '✅ Slot confirmed, payment link sent',              X_CENTER - 200, Y_SPACING * 3),
    node('faq',       'message',     'FAQ Reply',           '❓ Price, rules, availability',                     X_CENTER + 200, Y_SPACING * 2),
    node('agent',     'message',     'Agent Handover',      '👤 Connecting to turf manager',                    X_CENTER + 200, Y_SPACING * 3),
  ];
  const edges = [
    edge('e1', 'trigger', 'welcome',  ''),
    edge('e2', 'welcome', 'book',     '📅 Book Turf'),
    edge('e3', 'welcome', 'faq',      '❓ FAQ'),
    edge('e4', 'book',    'confirm',  '✅ Confirm Slot'),
    edge('e5', 'faq',     'agent',    '🧑 More Help'),
  ];
  return { nodes, edges };
}

// =============================================================================
// 4. AGENCY / OTHER (Generic)
// =============================================================================
function getGenericFlow() {
  const nodes = [
    node('trigger', 'trigger',     'Hi / Hello',       'User initiates conversation',                   X_CENTER, 0),
    node('welcome', 'interactive', 'Welcome Message',  '👋 "Hi! How can we help you today?" + options', X_CENTER, Y_SPACING),
    node('info',    'message',     'Service Info',     '📋 Describes your services and next steps',     X_CENTER - 200, Y_SPACING * 2),
    node('faq',     'message',     'FAQ / Support',    '❓ Common questions answered',                  X_CENTER + 200, Y_SPACING * 2),
    node('agent',   'message',     'Agent Handover',   '👤 Connecting to a team member',               X_CENTER, Y_SPACING * 3),
  ];
  const edges = [
    edge('e1', 'trigger', 'welcome', ''),
    edge('e2', 'welcome', 'info',    '📋 Learn More'),
    edge('e3', 'welcome', 'faq',     '❓ FAQ'),
    edge('e4', 'info',    'agent',   '🧑 Talk to Us'),
    edge('e5', 'faq',     'agent',   '🧑 More Help'),
  ];
  return { nodes, edges };
}

// =============================================================================
// MAIN EXPORT – getDefaultFlowForNiche(niche)
// =============================================================================
function getDefaultFlowForNiche(niche) {
  switch ((niche || '').toLowerCase()) {
    case 'ecommerce': return getEcommerceFlow();
    case 'salon':
    case 'clinic':    return getSalonFlow();
    case 'turf':      return getTurfFlow();
    default:          return getGenericFlow();
  }
}

module.exports = { getDefaultFlowForNiche };
