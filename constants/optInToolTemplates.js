/**
 * Opt-in tool template catalog — 12 India-specific templates (Phase 1).
 * Note: popup_cod_first was removed (COD is a payment method, not a coupon discount).
 * Replaced with popup_first_order_100 (₹100 fixed discount via Shopify).
 */
const { defaultDesignForType } = require('./optInToolDefaults');

const TEMPLATE_OVERRIDES = {
  popup_welcome_10: {
    headline: 'Get 10% off your first order',
    subheadline: 'Join our WhatsApp VIP — prices in ₹, COD available.',
    offerText: 'Exclusive for Indian shoppers. Valid on your first order.',
  },
  popup_festive: {
    headline: 'Festive sale is live 🪔',
    subheadline: 'Extra savings on WhatsApp — limited time Diwali offers.',
    offerText: 'Celebrate with us — subscribe for festive deals.',
    colors: { buttonBackground: '#D97706' },
  },
  popup_first_order_100: {
    headline: '₹100 off your first order',
    subheadline: 'Subscribe on WhatsApp — get your code instantly.',
    offerText: 'Valid on orders above ₹699. For Indian shoppers.',
    discount: { mode: 'auto_shopify', discountType: 'fixed_amount', discountValue: 100, minimumOrderAmount: 699 },
  },
  popup_free_shipping: {
    headline: 'Free shipping over ₹999',
    subheadline: 'Subscribe on WhatsApp for delivery offers.',
    offerText: 'Pan-India shipping on orders above ₹999.',
    discount: { minimumOrderAmount: 999 },
  },
  popup_whatsapp_vip: {
    headline: 'Join our WhatsApp VIP list',
    subheadline: 'Early access to drops, restocks & member-only codes.',
    offerText: 'Be the first to know — no spam, reply STOP anytime.',
    discount: { mode: 'manual', manualCode: '' },
  },
  popup_image_hero: {
    headline: 'Unlock your welcome offer',
    subheadline: 'Full-bleed hero — add your product image in the editor.',
    showImage: true,
    imageUrl: '',
  },
  popup_minimal: {
    headline: 'Welcome',
    subheadline: 'Get updates on WhatsApp.',
    offerText: '',
    colors: { panelBackground: '#FFFFFF', overlay: 'rgba(15,23,42,0.35)' },
  },
  popup_hindi: {
    headline: 'स्वागत है — 10% छूट पाएं',
    subheadline: 'WhatsApp पर ऑफर्स और ऑर्डर अपडेट पाएं।',
    offerText: 'कैश ऑन डिलीवरी उपलब्ध।',
    brandKit: { font: 'Noto Sans Devanagari' },
  },
};

const TEMPLATE_CATALOG = [
  { id: 'popup_welcome_10', name: 'Welcome 10% off', type: 'popup', tags: ['popup', 'discount', 'india'], previewColor: '#7C3AED' },
  { id: 'popup_festive', name: 'Festive sale', type: 'popup', tags: ['popup', 'festive', 'india'], previewColor: '#D97706' },
  { id: 'popup_first_order_100', name: '₹100 off first order', type: 'popup', tags: ['popup', 'discount', 'india'], previewColor: '#7C3AED' },
  { id: 'popup_free_shipping', name: 'Free shipping over ₹X', type: 'popup', tags: ['popup', 'shipping', 'india'], previewColor: '#2563EB' },
  { id: 'popup_whatsapp_vip', name: 'Join WhatsApp VIP', type: 'popup', tags: ['popup', 'whatsapp'], previewColor: '#7C3AED' },
  { id: 'popup_image_hero', name: 'Hero image popup', type: 'popup', tags: ['popup', 'image'], previewColor: '#0F172A' },
  { id: 'popup_minimal', name: 'Clean minimal', type: 'popup', tags: ['popup', 'minimal'], previewColor: '#7C3AED' },
  { id: 'popup_hindi', name: 'Hindi welcome', type: 'popup', tags: ['popup', 'hindi', 'india'], previewColor: '#7C3AED' },
  { id: 'spin_default', name: 'Spin to win', type: 'spin_wheel', tags: ['spin', 'gamification'], previewColor: '#7C3AED' },
  { id: 'mystery_scratch', name: 'Scratch & win', type: 'mystery_discount', tags: ['mystery', 'scratch'], previewColor: '#D4AF37' },
  { id: 'mystery_tap', name: 'Tap to reveal', type: 'mystery_discount', tags: ['mystery', 'tap'], previewColor: '#C0C0C0' },
  { id: 'widget_wa_default', name: 'WA chat bubble', type: 'whatsapp_widget', tags: ['widget', 'whatsapp'], previewColor: '#7C3AED' },
];

function getTemplateDesignDefaults(templateId, type) {
  const base = defaultDesignForType(type);
  const overrides = TEMPLATE_OVERRIDES[templateId] || {};
  return {
    ...base,
    ...overrides,
    brandKit: { ...base.brandKit, ...(overrides.brandKit || {}) },
    colors: { ...base.colors, ...(overrides.colors || {}) },
    discount: { ...base.discount, ...(overrides.discount || {}) },
  };
}

function listTemplates({ type, search } = {}) {
  let items = TEMPLATE_CATALOG.map((t) => ({ ...t }));
  if (type) items = items.filter((t) => t.type === type);
  if (search) {
    const q = String(search).toLowerCase().trim();
    items = items.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        (t.tags || []).some((tag) => tag.includes(q))
    );
  }
  return items;
}

function getTemplateById(id) {
  const meta = TEMPLATE_CATALOG.find((t) => t.id === id);
  if (!meta) return null;
  return { ...meta, designDefaults: getTemplateDesignDefaults(id, meta.type) };
}

module.exports = { TEMPLATE_CATALOG, listTemplates, getTemplateById, getTemplateDesignDefaults };
