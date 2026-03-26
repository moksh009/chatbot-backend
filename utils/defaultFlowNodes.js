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
    { id: 'trigger', type: 'trigger', position: { x: X_CENTER, y: 0 }, data: { keyword: 'hi' } },
    { 
      id: 'welcome', 
      type: 'interactive', 
      position: { x: X_CENTER - 150, y: Y_SPACING }, 
      data: { 
        header: 'Welcome! 👋', 
        text: 'Welcome to our store! How can we help you today?', 
        buttonsList: [
          { id: 'menu_products', title: '🛍️ Shop Now' },
          { id: 'menu_support', title: '❓ Support' }
        ]
      } 
    },
    { 
      id: 'catalog', 
      type: 'message', 
      position: { x: X_CENTER - 300, y: Y_SPACING * 2 }, 
      data: { title: 'Product Catalog', text: 'Browse our premium models below. Tap "Buy Now" to order!' } 
    },
    { 
      id: 'support', 
      type: 'interactive', 
      position: { x: X_CENTER + 150, y: Y_SPACING * 2 }, 
      data: { 
        header: 'Support Center', 
        text: 'How can we assist you?', 
        buttonsList: [
          { id: 'faq_shipping', title: '🚚 Shipping' },
          { id: 'menu_agent', title: '👤 Talk to Agent' }
        ]
      } 
    },
    { 
      id: 'agent_hand', 
      type: 'message', 
      position: { x: X_CENTER + 150, y: Y_SPACING * 3 }, 
      data: { text: 'Connecting you to our support team... please wait a moment! 👤' } 
    }
  ];
  const edges = [
    { id: 'e1', source: 'trigger', target: 'welcome', animated: true },
    { id: 'e2', source: 'welcome', target: 'catalog', sourceHandle: 'menu_products', animated: true },
    { id: 'e3', source: 'welcome', target: 'support', sourceHandle: 'menu_support', animated: true },
    { id: 'e4', source: 'support', target: 'agent_hand', sourceHandle: 'menu_agent', animated: true },
  ];
  return { nodes, edges };
}

// =============================================================================
// 2. SALON / CLINIC (Choice Salon-style)
// =============================================================================
function getSalonFlow() {
  const nodes = [
    { id: 'trigger', type: 'trigger', position: { x: X_CENTER, y: 0 }, data: { keyword: 'hi' } },
    { 
      id: 'welcome', 
      type: 'interactive', 
      position: { x: X_CENTER, y: Y_SPACING }, 
      data: { 
        header: 'Choice Salon 💅', 
        text: 'Welcome! Choose an option to get started:', 
        buttonsList: [
          { id: 'services', title: '📋 Services' },
          { id: 'menu_support', title: '❓ FAQ' }
        ]
      } 
    },
    { 
      id: 'services_node', 
      type: 'interactive', 
      position: { x: X_CENTER - 200, y: Y_SPACING * 2 }, 
      data: { 
        header: 'Our Services', 
        text: 'Select a category to see pricing:', 
        buttonsList: [
          { id: 'book_now', title: '📅 Book Now' },
          { id: 'back_menu', title: '⬅️ Back' }
        ]
      } 
    },
    { 
      id: 'book_flow', 
      type: 'message', 
      position: { x: X_CENTER - 200, y: Y_SPACING * 3 }, 
      data: { text: 'Opening our booking system... Please select your preferred time! 📅' } 
    }
  ];
  const edges = [
    { id: 'e1', source: 'trigger', target: 'welcome', animated: true },
    { id: 'e2', source: 'welcome', target: 'services_node', sourceHandle: 'services', animated: true },
    { id: 'e3', source: 'services_node', target: 'book_flow', sourceHandle: 'book_now', animated: true },
    { id: 'e4', source: 'services_node', target: 'welcome', sourceHandle: 'back_menu', animated: true },
  ];
  return { nodes, edges };
}

// =============================================================================
// 3. TURF
// =============================================================================
function getTurfFlow() {
  const nodes = [
    { id: 'trigger', type: 'trigger', position: { x: X_CENTER, y: 0 }, data: { keyword: 'book' } },
    { 
      id: 'welcome', 
      type: 'interactive', 
      position: { x: X_CENTER, y: Y_SPACING }, 
      data: { 
        header: 'Turf Booking ⚽', 
        text: 'Ready to play? Select an option:', 
        buttonsList: [
          { id: 'book_slot', title: '📅 Book Slot' },
          { id: 'prices', title: '📋 Price List' }
        ]
      } 
    }
  ];
  const edges = [
    { id: 'e1', source: 'trigger', target: 'welcome', animated: true }
  ];
  return { nodes, edges };
}

// =============================================================================
// 4. AGENCY / OTHER (Generic)
// =============================================================================
function getGenericFlow() {
  const nodes = [
    { id: 'trigger', type: 'trigger', position: { x: X_CENTER, y: 0 }, data: { keyword: 'hi' } },
    { 
      id: 'welcome', 
      type: 'interactive', 
      position: { x: X_CENTER, y: Y_SPACING }, 
      data: { 
        text: 'Hello! How can we help you today?', 
        buttonsList: [
          { id: 'contact', title: '📞 Contact Us' },
          { id: 'about', title: 'ℹ️ About' }
        ]
      } 
    }
  ];
  const edges = [
    { id: 'e1', source: 'trigger', target: 'welcome', animated: true }
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
