'use strict';

/**
 * Launch checklist for new merchants (Module 19).
 * Order is intentional — matches commerce-meta-alignment spec.
 */
const MERCHANT_PLAYBOOK_STEPS = [
  {
    id: 'connect_shopify',
    order: 1,
    title: 'Connect Shopify',
    description: 'Link your store so we can sync products, orders, and customers.',
    href: '/settings?tab=integrations',
    cta: 'Open integrations',
  },
  {
    id: 'connect_whatsapp',
    order: 2,
    title: 'Connect WhatsApp',
    description: 'Connect your WhatsApp Business API to send and receive messages.',
    href: '/settings?tab=integrations',
    cta: 'Connect WhatsApp',
  },
  {
    id: 'sync_catalog',
    order: 3,
    title: 'Sync products and orders',
    description: 'Pull your catalog and recent orders into TopEdge.',
    href: '/commerce-hub?tab=products',
    cta: 'Open Store Engine',
  },
  {
    id: 'install_pixel',
    order: 4,
    title: 'Install tracking pixel',
    description: 'Capture cart and checkout events for analytics and abandoned cart recovery.',
    href: '/commerce-hub?tab=tracking',
    cta: 'Open Tracking',
  },
  {
    id: 'sync_templates',
    order: 5,
    title: 'Sync templates from Meta',
    description: 'Pull your approved WhatsApp templates from Meta.',
    href: '/meta-manager?tab=library',
    cta: 'Template library',
  },
  {
    id: 'push_eco_templates',
    order: 6,
    title: 'Push order message templates',
    description: 'Submit standard eco order templates to Meta for approval.',
    href: '/meta-manager?tab=library&section=eco-starters',
    cta: 'Push templates',
  },
  {
    id: 'enable_order_messages',
    order: 7,
    title: 'Activate order status messages',
    description: 'Turn on paid, shipped, and delivered WhatsApp updates.',
    href: '/shopify-automation-center?section=order-messages',
    cta: 'Order messages',
  },
  {
    id: 'configure_persona',
    order: 8,
    title: 'Configure AI persona',
    description: 'Set how your bot sounds when it replies to customers.',
    href: '/intelligence-hub?tab=persona',
    cta: 'AI persona',
  },
  {
    id: 'score_rules',
    order: 9,
    title: 'Review score rules',
    description: 'Confirm lead scoring tiers or keep the default waterfall rules.',
    href: '/audience-hub?tab=intent-simulator',
    cta: 'Score rules',
  },
  {
    id: 'consent_rules',
    order: 10,
    title: 'Configure consent rules',
    description: 'Set WhatsApp marketing consent and STOP keyword handling.',
    href: '/audience-hub?tab=growth-consent',
    cta: 'Consent settings',
  },
];

const SOFT_COMPLETE_MIN = 7;

module.exports = { MERCHANT_PLAYBOOK_STEPS, SOFT_COMPLETE_MIN };
