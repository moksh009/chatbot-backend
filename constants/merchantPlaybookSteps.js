'use strict';

/**
 * Launch checklist for new merchants (Module 19).
 * Order is intentional — matches commerce-meta-alignment spec.
 */
const MERCHANT_PLAYBOOK_STEPS = [
  {
    id: 'connect_shopify',
    order: 1,
    title: 'Connect your Shopify store',
    description: 'Link your store so we can see orders, products, and customers.',
    href: '/settings?tab=connections&connect=shopify',
    cta: 'Connect Shopify',
  },
  {
    id: 'connect_whatsapp',
    order: 2,
    title: 'Connect WhatsApp',
    description: 'Add your WhatsApp number so customers can message you.',
    href: '/settings?tab=connections&connect=whatsapp',
    cta: 'Connect WhatsApp',
  },
  {
    id: 'sync_catalog',
    order: 3,
    title: 'Sync products and orders',
    description: 'Pull your catalog and recent orders into TopEdge.',
    href: '/commerce-hub?tab=products',
    cta: 'Open your store',
  },
  {
    id: 'install_pixel',
    order: 4,
    title: 'Add website tracking',
    description: 'Track carts and checkouts for abandoned cart messages.',
    href: '/commerce-hub?tab=tracking',
    cta: 'Open tracking',
  },
  {
    id: 'sync_templates',
    order: 5,
    title: 'Get WhatsApp templates',
    description: 'Pull your approved message templates from Meta.',
    href: '/meta-manager?tab=library',
    cta: 'Template list',
  },
  {
    id: 'push_eco_templates',
    order: 6,
    title: 'Set up order message templates',
    description: 'Submit standard order templates to Meta for approval.',
    href: '/meta-manager?tab=library&section=eco-starters',
    cta: 'Push templates',
  },
  {
    id: 'enable_order_messages',
    order: 7,
    title: 'Turn on order updates',
    description: 'Send paid, shipped, and delivered messages on WhatsApp.',
    href: '/shopify-automation-center?section=order-messages',
    cta: 'Order updates',
  },
  {
    id: 'train_intents',
    order: 8,
    title: 'Teach your bot what to say',
    description: 'Define common customer questions and how to reply.',
    href: '/intelligence-hub?tab=intent-engine',
    cta: 'Train bot',
  },
  {
    id: 'score_rules',
    order: 9,
    title: 'Set lead scores',
    description: 'Choose how hot leads are ranked, or keep the defaults.',
    href: '/audience-hub?tab=intent-simulator',
    cta: 'Score rules',
  },
];

const SOFT_COMPLETE_MIN = 7;

module.exports = { MERCHANT_PLAYBOOK_STEPS, SOFT_COMPLETE_MIN };
