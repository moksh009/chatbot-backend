'use strict';

const { FLOW_LAYOUT_SECTIONS } = require('./flowLayoutSections');

/** Base feature flags — all others default false unless overridden. */
const BASE_OFF = {
  enableCatalog: false,
  enableOrderTracking: false,
  enableCancelOrder: false,
  enableReturnsRefunds: false,
  enableWarranty: false,
  enableInstallSupport: false,
  enableFAQ: false,
  enableAbandonedCart: false,
  enableReviewCollection: false,
  enableSupportEscalation: true,
  enableAIFallback: true,
  enableBusinessHoursGate: false,
  enableCodToPrepaid: false,
  enableB2BWholesale: false,
  enableReferral: false,
  enableAdminAlerts: false,
};

/**
 * E-commerce flow template catalog (V1).
 * Graphs are generated via flowGenerator feature presets + organizeFlowGraph.
 */
/** V1 ships one installable template — merchants publish a single active WhatsApp flow. */
const FLOW_TEMPLATE_CATALOG = [
  {
    key: 'store_bot_complete',
    name: 'Complete WhatsApp Store Bot',
    description:
      'End-to-end store bot for Indian D2C — product catalog, cart recovery, cancel and returns, warranty, install help, FAQ, business hours, and live agent handoff in one organised flow.',
    useCaseLabel: 'Recommended',
    sidebarFolderName: 'WhatsApp Store Bot',
    flowName: (client) => `${client?.businessName || client?.name || 'Store'} — WhatsApp bot`,
    useWizardPack: true,
    requiresShopify: true,
    requiresWhatsApp: true,
    estimatedSteps: 75,
    estimatedCanvasFolders: 8,
    canvasSectionKeys: ['entry', 'catalog', 'orders', 'returns', 'support', 'automation', 'ai'],
    featurePreset: {
      ...BASE_OFF,
      enableCatalog: true,
      enableOrderTracking: false,
      enableCancelOrder: true,
      enableReturnsRefunds: true,
      enableWarranty: true,
      enableInstallSupport: true,
      enableFAQ: true,
      enableAbandonedCart: true,
      enableReviewCollection: false,
      enableSupportEscalation: true,
      enableAIFallback: true,
      enableBusinessHoursGate: true,
      enableCodToPrepaid: false,
      enableAdminAlerts: true,
    },
    metaTemplateSlots: [
      'cart_recovery_1',
      'cart_recovery_2',
      'cart_recovery_3',
      'om_order_confirm',
      'om_order_shipped',
      'om_order_delivered',
    ],
  },
];

function getTemplateDefinition(key) {
  return FLOW_TEMPLATE_CATALOG.find((t) => t.key === key) || null;
}

function listTemplateCatalog() {
  return FLOW_TEMPLATE_CATALOG.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    useCaseLabel: t.useCaseLabel,
    sidebarFolderName: t.sidebarFolderName,
    requiresShopify: t.requiresShopify,
    requiresWhatsApp: t.requiresWhatsApp,
    estimatedSteps: t.estimatedSteps,
    estimatedCanvasFolders: t.estimatedCanvasFolders,
    flowsCreated: 1,
    canvasFolders: t.canvasSectionKeys
      .map((k) => FLOW_LAYOUT_SECTIONS.find((s) => s.key === k)?.label?.replace(/^[^\s]+\s/, '') || k)
      .filter(Boolean),
    metaTemplateSlots: t.metaTemplateSlots || [],
  }));
}

function folderIdForTemplate(key) {
  return `folder_tpl_${key}`;
}

function buildInstallChecklist(templateDef) {
  const items = [
    {
      id: 'connect_whatsapp',
      label: 'Connect WhatsApp Business',
      required: true,
      href: '/settings?tab=connections&connect=whatsapp',
    },
    {
      id: 'publish_flow',
      label: 'Review and publish this flow',
      required: true,
      href: null,
    },
  ];

  if (templateDef.requiresShopify) {
    items.splice(1, 0, {
      id: 'connect_shopify',
      label: 'Connect Shopify store',
      required: true,
      href: '/settings?tab=connections&connect=shopify',
    });
  }

  if (Array.isArray(templateDef.metaTemplateSlots) && templateDef.metaTemplateSlots.length > 0) {
    items.splice(templateDef.requiresShopify ? 2 : 1, 0, {
      id: 'approve_meta_templates',
      label: 'Approve Meta message templates in Meta Manager',
      required: true,
      href: '/meta-manager?tab=library',
      detail: templateDef.metaTemplateSlots.join(', '),
    });
  }

  return items;
}

module.exports = {
  FLOW_TEMPLATE_CATALOG,
  getTemplateDefinition,
  listTemplateCatalog,
  folderIdForTemplate,
  buildInstallChecklist,
};
