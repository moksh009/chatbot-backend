"use strict";

const createNode = (id, type, x, y, label, text, parentId = null, extra = {}) => ({
  id,
  type,
  position: { x, y },
  parentId,
  data: {
    label,
    text,
    ...extra
  }
});

const createTrigger = (id, x, y, keyword = 'hi') => ({
  id,
  type: 'trigger',
  position: { x, y },
  data: { label: 'Start Trigger', keyword }
});

const createEdge = (id, source, target, sourceHandle = null) => ({
  id, source, target, sourceHandle, animated: true
});

const ecommercePreset = () => {
  const nodes = [
    createTrigger('trigger-1', 400, 0),
    createNode('welcome-1', 'interactive', 400, 160,
      'Welcome',
      "Hi! 👋 Welcome to Our Store!\n\nWe're here to help you find the perfect products.\n\nWhat would you like to do today?",
      null,
      {
        buttonsList: [
          { id: 'btn-shop', title: '🛒 Shop Now' },
          { id: 'btn-track', title: '📦 Track My Order' },
          { id: 'btn-support', title: '💬 Support' }
        ]
      }
    ),
    createNode('folder-shop-1', 'folder', 200, 400, 'Shopping Flow', null),
    createNode('folder-help-1', 'folder', 650, 400, 'Customer Support', null),
    
    // Inside Shop Folder
    createNode('products-1', 'message', 100, 100, 'AI Catalog', "Check our best items: {{product_list}}\n\nReply with a product name to see more details!", 'folder-shop-1'),
    createNode('cart-1', 'message', 100, 250, 'Checkout', "Complete your order here: {{buy_url}}", 'folder-shop-1'),
    
    // Inside Help Folder
    createNode('track-1', 'message', 100, 100, 'Order Status', "Checking your order status... 🔍\n\n{{order_status_summary}}", 'folder-help-1', { action: 'CHECK_ORDER_STATUS' }),
    createNode('support-1', 'message', 100, 250, 'Talk to Agent', "Our team is here to help! 👤", 'folder-help-1', { action: 'ESCALATE_HUMAN' })
  ];
  
  const edges = [
    createEdge('e1', 'trigger-1', 'welcome-1'),
    createEdge('e2', 'welcome-1', 'folder-shop-1', 'btn-shop'),
    createEdge('e3', 'welcome-1', 'folder-help-1', 'btn-support'),
    createEdge('e4', 'folder-shop-1', 'products-1'),
    createEdge('e5', 'products-1', 'cart-1'),
    createEdge('e6', 'welcome-1', 'folder-help-1', 'btn-track'),
    createEdge('e7', 'folder-help-1', 'track-1'),
    createEdge('e8', 'track-1', 'support-1')
  ];
  
  return { nodes, edges };
};

const salonPreset = () => {
    const nodes = [
      createTrigger('trigger-1', 400, 0),
      createNode('welcome-1', 'interactive', 400, 160,
        'Welcome',
        "Welcome to our Studio! 💇‍♀️\n\nReady for a fresh look? How can we help you today?",
        null,
        {
          buttonsList: [
            { id: 'btn-services', title: '💇‍♀️ View Services' },
            { id: 'btn-book', title: '📅 Book Now' },
            { id: 'btn-location', title: '📍 Location' }
          ]
        }
      ),
      createNode('folder-booking', 'folder', 300, 400, 'Booking Journey', null),
      createNode('services-1', 'message', 100, 80, 'Our Services', "We offer haircuts, styling, and color treatments! 💇‍♀️", 'folder-booking'),
      createNode('booking-1', 'message', 100, 220, 'Book Slot', "Click the link to pick your favorite stylist! 📅", 'folder-booking'),
      createNode('location-1', 'message', 650, 400, 'Location', "Visit us at Main St. 📍 we'd love to see you!", null)
    ];
    
    const edges = [
      createEdge('e1', 'trigger-1', 'welcome-1'),
      createEdge('e2', 'welcome-1', 'folder-booking', 'btn-services'),
      createEdge('e3', 'welcome-1', 'folder-booking', 'btn-book'),
      createEdge('e4', 'welcome-1', 'location-1', 'btn-location'),
      createEdge('e5', 'folder-booking', 'services-1'),
      createEdge('e6', 'services-1', 'booking-1')
    ];
    
    return { nodes, edges };
};

const generalPreset = () => {
    const nodes = [
      createTrigger('trigger-1', 400, 0),
      createNode('welcome-1', 'interactive', 400, 160,
        'Welcome',
        "Hello! I am your AI assistant. 🤖\n\nWhat would you like to know about us?",
        null,
        {
          buttonsList: [
            { id: 'btn-about', title: '🏢 About Us' },
            { id: 'btn-support', title: '💬 Support' }
          ]
        }
      ),
      createNode('about-1', 'message', 150, 400, 'About', "We are a technology solutions provider. 🏢", null),
      createNode('support-1', 'message', 650, 400, 'Support', "Connecting you to an expert... 👤", null, { action: 'ESCALATE_HUMAN' })
    ];
    
    const edges = [
      createEdge('e1', 'trigger-1', 'welcome-1'),
      createEdge('e2', 'welcome-1', 'about-1', 'btn-about'),
      createEdge('e3', 'welcome-1', 'support-1', 'btn-support')
    ];
    
    return { nodes, edges };
};

module.exports = {
  getPreset: (type) => {
    if (type === 'ecommerce') return ecommercePreset();
    if (type === 'salon') return salonPreset();
    return generalPreset();
  }
};
