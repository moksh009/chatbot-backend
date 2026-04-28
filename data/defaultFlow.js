/**
 * DEFAULT WELCOME FLOW — Auto-created for new clients
 * Ensures "Hi" always gets a response even before the client uses the builder.
 * 
 * Trigger keywords: hi, hello, hey, menu, start
 * Structure: Trigger → Welcome Menu (3 buttons) → Response nodes
 */

function createDefaultFlow(client = {}) {
  const businessName = client.businessName || client.name || 'our team';
  const storeUrl = client.nicheData?.storeUrl || '';

  const nodes = [
    {
      id: 'trigger_welcome',
      type: 'trigger',
      position: { x: 250, y: 50 },
      data: {
        label: 'Welcome Trigger',
        trigger: {
          type: 'keyword',
          keywords: ['hi', 'hello', 'hey', 'menu', 'start', 'hii', 'hiii'],
          matchMode: 'contains',
          channel: 'whatsapp'
        },
        role: 'starter',
        keywords: 'hi,hello,hey,menu,start'
      }
    },
    {
      id: 'msg_welcome',
      type: 'interactive',
      position: { x: 250, y: 220 },
      data: {
        label: 'Welcome Menu',
        text: `Hi there! 👋 Welcome to *${businessName}*.\n\nHow can I help you today?`,
        body: `Hi there! 👋 Welcome to *${businessName}*.\n\nHow can I help you today?`,
        interactiveType: 'button',
        buttonsList: [
          { id: 'btn_products', title: '🛍️ Our Products' },
          { id: 'btn_support', title: '💬 Get Support' },
          { id: 'btn_info', title: 'ℹ️ About Us' }
        ]
      }
    },
    {
      id: 'msg_products',
      type: 'message',
      position: { x: 50, y: 450 },
      data: {
        label: 'Products Info',
        text: `🛍️ We'd love to show you what we have!\n\n${storeUrl ? `Browse our store: ${storeUrl}` : 'Our team will share our latest catalog with you shortly.'}\n\nNeed help choosing? Just ask! 😊`,
        body: `🛍️ We'd love to show you what we have!\n\n${storeUrl ? `Browse our store: ${storeUrl}` : 'Our team will share our latest catalog with you shortly.'}\n\nNeed help choosing? Just ask! 😊`
      }
    },
    {
      id: 'msg_support',
      type: 'message',
      position: { x: 250, y: 450 },
      data: {
        label: 'Support Response',
        text: `💬 Our support team is here to help!\n\nPlease describe your issue and a team member will assist you shortly. 👤`,
        body: `💬 Our support team is here to help!\n\nPlease describe your issue and a team member will assist you shortly. 👤`
      }
    },
    {
      id: 'msg_about',
      type: 'message',
      position: { x: 450, y: 450 },
      data: {
        label: 'About Us',
        text: `ℹ️ *About ${businessName}*\n\nThank you for your interest! We're committed to providing the best experience for our customers.\n\nType "menu" anytime to see options again. 😊`,
        body: `ℹ️ *About ${businessName}*\n\nThank you for your interest! We're committed to providing the best experience for our customers.\n\nType "menu" anytime to see options again. 😊`
      }
    }
  ];

  const edges = [
    {
      id: 'e_trigger_menu',
      source: 'trigger_welcome',
      sourceHandle: 'a',
      target: 'msg_welcome',
      targetHandle: 'target'
    },
    {
      id: 'e_menu_products',
      source: 'msg_welcome',
      sourceHandle: 'btn_products',
      target: 'msg_products',
      targetHandle: 'target'
    },
    {
      id: 'e_menu_support',
      source: 'msg_welcome',
      sourceHandle: 'btn_support',
      target: 'msg_support',
      targetHandle: 'target'
    },
    {
      id: 'e_menu_about',
      source: 'msg_welcome',
      sourceHandle: 'btn_info',
      target: 'msg_about',
      targetHandle: 'target'
    }
  ];

  return { nodes, edges };
}

module.exports = { createDefaultFlow };
