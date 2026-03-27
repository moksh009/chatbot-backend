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
const X_CENTER = 400;

// ─── shared helper ────────────────────────────────────────────────────────────
function node(id, type, label, text, x, y, extra = {}) {
  return {
    id,
    type,
    position: { x, y },
    data: { label, text, ...extra }
  };
}
function edge(id, source, target, sourceHandle = null) {
  return { id, source, target, sourceHandle, animated: true };
}

// =============================================================================
// 1. ECOMMERCE (Delitech-style / Generic eCommerce)
// =============================================================================
function getEcommerceFlow() {
  const nodes = [
    node('trigger', 'trigger', 'Start', 'hi', X_CENTER, 0),
    node('welcome', 'interactive', 'Welcome', 'Welcome to our store! 👋 How can we help you?', X_CENTER, Y_SPACING, {
      buttonsList: [
        { id: 'goto_catalog', title: '🛍️ Shop Now' },
        { id: 'goto_support', title: '❓ Support' }
      ]
    }),
    node('folder_shop', 'folder', 'Shopping Flow', null, X_CENTER - 150, Y_SPACING * 2),
    node('folder_help', 'folder', 'Customer Support', null, X_CENTER + 150, Y_SPACING * 2),
    
    // Inside Shop Folder
    { ...node('catalog', 'message', 'Catalog', 'Browse our latest arrivals! 📦\n\n{{product_list}}', 100, 100), parentId: 'folder_shop' },
    { ...node('buy', 'message', 'Checkout', 'Ready to buy? Click here: {{buy_url}}', 100, 250), parentId: 'folder_shop' },
    
    // Inside Help Folder
    { ...node('agent', 'message', 'Talk to Human', 'Connecting you now... 👤', 100, 100, { action: 'ESCALATE_HUMAN' }), parentId: 'folder_help' }
  ];
  const edges = [
    edge('e1', 'trigger', 'welcome'),
    edge('e2', 'welcome', 'folder_shop', 'goto_catalog'),
    edge('e3', 'welcome', 'folder_help', 'goto_support'),
    edge('e4', 'folder_shop', 'catalog'),
    edge('e5', 'catalog', 'buy'),
    edge('e6', 'folder_help', 'agent'),
  ];
  return { nodes, edges };
}

// =============================================================================
// 2. SALON / CLINIC (Choice Salon-style)
// =============================================================================
function getSalonFlow() {
  const nodes = [
    node('trigger', 'trigger', 'Greeting', 'hi', X_CENTER, 0),
    node('welcome', 'interactive', 'Entrance', 'Welcome to the salon! ✨ Book an appointment or see our gallery.', X_CENTER, Y_SPACING, {
      buttonsList: [
        { id: 'goto_book', title: '📅 Book Now' },
        { id: 'goto_faq', title: '❓ FAQ' }
      ]
    }),
    node('folder_book', 'folder', 'Booking System', null, X_CENTER - 150, Y_SPACING * 2),
    
    // Inside Booking Folder
    { ...node('services', 'message', 'Services', 'Our premium services: \n\n{{service_list}}', 100, 100, { action: 'SHOW_SERVICES' }), parentId: 'folder_book' },
    { ...node('slots', 'message', 'Time Slots', 'Available times: \n\n{{slot_list}}', 100, 250, { action: 'SHOW_SLOTS' }), parentId: 'folder_book' }
  ];
  const edges = [
    edge('e1', 'trigger', 'welcome'),
    edge('e2', 'welcome', 'folder_book', 'goto_book'),
    edge('e3', 'folder_book', 'services'),
    edge('e4', 'services', 'slots'),
  ];
  return { nodes, edges };
}

// =============================================================================
// 3. TURF
// =============================================================================
function getTurfFlow() {
  const nodes = [
    node('trigger', 'trigger', 'Start', 'book', X_CENTER, 0),
    node('welcome', 'interactive', 'Welcome', 'Ready for a match? ⚽ Book your turf slot now!', X_CENTER, Y_SPACING, {
      buttonsList: [
        { id: 'book_slot', title: '📅 Book Slot' },
        { id: 'prices', title: '💰 Pricing' }
      ]
    }),
    node('slots', 'message', 'Available Slots', 'Checking for open time slots... 🕒\n\n{{slot_list}}', X_CENTER, Y_SPACING * 2, { action: 'SHOW_TURF_SLOTS' })
  ];
  const edges = [
    edge('e1', 'trigger', 'welcome'),
    edge('e2', 'welcome', 'slots', 'book_slot')
  ];
  return { nodes, edges };
}

// =============================================================================
// 4. AGENCY / OTHER (Generic)
// =============================================================================
function getGenericFlow() {
  const nodes = [
    node('trigger', 'trigger', 'Hello', 'hi', X_CENTER, 0),
    node('welcome', 'interactive', 'Menu', 'Hello! How can we assist you today? 👤', X_CENTER, Y_SPACING, {
      buttonsList: [
        { id: 'contact', title: '📞 Contact' },
        { id: 'about', title: 'ℹ️ About' }
      ]
    })
  ];
  const edges = [
    edge('e1', 'trigger', 'welcome')
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
