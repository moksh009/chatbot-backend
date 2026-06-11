'use strict';

/** Canonical dashboard feature keys → merchant-facing labels */
const FEATURE_LABELS = {
  dashboard: 'Home',
  campaigns: 'Campaigns',
  flow_builder: 'Flow Builder',
  meta_manager: 'Meta Manager',
  order_messages: 'Order messages',
  cart_leads: 'Cart leads',
  commerce_hub: 'Store engine',
  live_chat: 'Live Chat',
  settings: 'Settings',
  insights: 'Insights',
  audience: 'Audience',
  marketing: 'Marketing hub',
  sequences: 'Sequences',
  intelligence: 'AI Brain',
  automation: 'Automation hub',
};

/** Onboarding funnel — server can verify steps without analytics consent */
const ONBOARDING_FUNNEL_STEPS = [
  { id: 'account_created', label: 'Account created', serverKey: 'account' },
  { id: 'shopify_connected', label: 'Shopify connected', serverKey: 'shopify' },
  { id: 'whatsapp_connected', label: 'WhatsApp connected', serverKey: 'whatsapp' },
  { id: 'first_template', label: 'First template submitted', serverKey: 'template' },
  { id: 'first_campaign', label: 'First campaign launched', serverKey: 'campaign' },
];

/** Product actions tracked via feature_click metadata.action */
const PRODUCT_ACTIONS = {
  campaign_launch: 'Campaign launched',
  flow_publish: 'Flow published',
  template_submit: 'Template submitted',
  shopify_connect: 'Shopify connected',
  whatsapp_connect: 'WhatsApp connected',
};

module.exports = {
  FEATURE_LABELS,
  ONBOARDING_FUNNEL_STEPS,
  PRODUCT_ACTIONS,
};
