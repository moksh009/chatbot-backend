"use strict";

/**
 * Store-category SSOT (backend half) — Phase 1.1 of FLOW-WIZARD-STORE-CATEGORY plan.
 *
 * Goal: every signup ecommerceCategories[], every AI brandProfile.productCategory,
 * every wizard INDUSTRIES dropdown label maps to one of these CANONICAL SLUGS.
 *
 * The wizard's vertical preset (`utils/flow/wizardFeaturePresets.js`) and the
 * features-step auto-tuning UI both read the resolved slug to decide whether
 * warranty / install / catalog flows make sense for the merchant.
 *
 * Keep this file in lock-step with:
 *   chatbot-dashboard-frontend-main/src/config/storeCategories.js
 * Any change to the slug list / mapper logic must be mirrored both sides.
 */

const DEFAULT_SLUG = 'general_d2c';

/**
 * @typedef {Object} StoreCategory
 * @property {string} slug          - canonical SSOT slug
 * @property {string} label         - user-facing label (sentence-case, ready for UI)
 * @property {string} presetKey     - existing key in PRESETS (wizardFeaturePresets.js)
 * @property {string} [shortLabel]  - terse chip label when space is tight
 * @property {boolean} [warranty]   - default toggle for enableWarranty
 * @property {boolean} [install]    - default toggle for enableInstallSupport
 * @property {boolean} [catalog]    - default for enableCatalog (true unless services-like)
 */

const STORE_CATEGORIES = [
  { slug: 'fashion_apparel',       label: 'Fashion & clothing',           shortLabel: 'Fashion',     presetKey: 'fashion',     warranty: false, install: false, catalog: true },
  { slug: 'electronics_smart_home', label: 'Electronics & smart home',     shortLabel: 'Electronics', presetKey: 'electronics', warranty: true,  install: true,  catalog: true },
  { slug: 'home_furniture',        label: 'Home & furniture',             shortLabel: 'Home',        presetKey: 'home',        warranty: true,  install: true,  catalog: true },
  { slug: 'beauty_personal_care',  label: 'Beauty & personal care',       shortLabel: 'Beauty',      presetKey: 'beauty',      warranty: false, install: false, catalog: true },
  { slug: 'food_beverage',         label: 'Food & beverage',              shortLabel: 'Food',        presetKey: 'food',        warranty: false, install: false, catalog: true },
  { slug: 'health_wellness',       label: 'Health & wellness',            shortLabel: 'Health',      presetKey: 'ecommerce',   warranty: false, install: false, catalog: true },
  { slug: 'jewellery_accessories', label: 'Jewellery & accessories',      shortLabel: 'Jewellery',   presetKey: 'fashion',     warranty: false, install: false, catalog: true },
  { slug: 'sports_fitness',        label: 'Sports & fitness',             shortLabel: 'Sports',      presetKey: 'ecommerce',   warranty: false, install: false, catalog: true },
  { slug: 'books_stationery',      label: 'Books & stationery',           shortLabel: 'Books',       presetKey: 'ecommerce',   warranty: false, install: false, catalog: true },
  { slug: 'toys_games',            label: 'Toys & games',                 shortLabel: 'Toys',        presetKey: 'ecommerce',   warranty: false, install: false, catalog: true },
  { slug: 'general_d2c',           label: 'General e-commerce',           shortLabel: 'D2C',         presetKey: 'ecommerce',   warranty: false, install: false, catalog: true },
  { slug: 'services_local',        label: 'Services & local business',    shortLabel: 'Services',    presetKey: 'services',    warranty: false, install: true,  catalog: false },
];

const SLUG_BY_KEY = STORE_CATEGORIES.reduce((acc, c) => {
  acc[c.slug] = c;
  return acc;
}, {});

/** Signup ecommerceCategories label (en-US) → slug. Multiple labels collapse to first match. */
const ECOMMERCE_LABEL_TO_SLUG = {
  // signup multiselect labels (ECOMMERCE_PRODUCT_CATEGORIES)
  'Fashion & Clothing':    'fashion_apparel',
  'Fashion and Clothing':  'fashion_apparel',
  'Clothing':              'fashion_apparel',
  'Apparel':               'fashion_apparel',
  'Shoes & Footwear':      'fashion_apparel',
  'Electronics':           'electronics_smart_home',
  'Smart Home':            'electronics_smart_home',
  'Gadgets':               'electronics_smart_home',
  'Home & Furniture':      'home_furniture',
  'Furniture':             'home_furniture',
  'Beauty & Skincare':     'beauty_personal_care',
  'Beauty & Personal Care':'beauty_personal_care',
  'Cosmetics':             'beauty_personal_care',
  'Skincare':              'beauty_personal_care',
  'Food & Beverages':      'food_beverage',
  'Grocery':               'food_beverage',
  'Health & Supplements':  'health_wellness',
  'Health & Wellness':     'health_wellness',
  'Wellness':              'health_wellness',
  'Jewellery':             'jewellery_accessories',
  'Jewelry':               'jewellery_accessories',
  'Accessories':           'jewellery_accessories',
  'Sports & Fitness':      'sports_fitness',
  'Fitness':               'sports_fitness',
  'Books & Stationery':    'books_stationery',
  'Books':                 'books_stationery',
  'Stationery':            'books_stationery',
  'Toys & Games':          'toys_games',
  'Toys':                  'toys_games',
  'Services':              'services_local',
  'Salon/Spa':             'services_local',
  'Clinic/Doctor':         'services_local',
  'Real Estate':           'services_local',
  'Education':             'services_local',
  'Restaurant':            'services_local',
  'Other':                 'general_d2c',
};

const AI_KEYWORD_RULES = [
  { test: /(cloth|apparel|fashion|wear|tshirt|tee|denim|saree|kurta|footwear|shoe)/i, slug: 'fashion_apparel' },
  { test: /(electron|smart\s*home|gadget|appliance|camera|doorbell|smartlight|router|tv|laptop|phone)/i, slug: 'electronics_smart_home' },
  { test: /(furniture|home\s*decor|sofa|bed|mattress|kitchenware|cookware)/i, slug: 'home_furniture' },
  { test: /(beauty|cosmetic|skincare|haircare|makeup|fragrance|perfume)/i, slug: 'beauty_personal_care' },
  { test: /(food|beverage|grocery|snack|bakery|chocolate|coffee|tea)/i, slug: 'food_beverage' },
  { test: /(health|wellness|supplement|vitamin|ayurveda|nutrition)/i, slug: 'health_wellness' },
  { test: /(jewel|jewellery|jewelry|ornament|bangle|necklace)/i, slug: 'jewellery_accessories' },
  { test: /(sport|fitness|gym|yoga|outdoor|cycling)/i, slug: 'sports_fitness' },
  { test: /(book|stationery|notebook|library)/i, slug: 'books_stationery' },
  { test: /(toy|game|puzzle|hobby)/i, slug: 'toys_games' },
  { test: /(service|salon|spa|clinic|consult|support|real\s*estate|education|tutor|restaurant)/i, slug: 'services_local' },
];

function _coerceString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isKnownSlug(slug) {
  return typeof slug === 'string' && Object.prototype.hasOwnProperty.call(SLUG_BY_KEY, slug);
}

function getStoreCategoryBySlug(slug) {
  return SLUG_BY_KEY[slug] || SLUG_BY_KEY[DEFAULT_SLUG];
}

/** Multi-select signup labels → single slug (first match wins). */
function mapOnboardingCategoriesToSlug(categories) {
  const list = Array.isArray(categories) ? categories : [];
  for (const raw of list) {
    const label = _coerceString(raw);
    if (!label) continue;
    if (ECOMMERCE_LABEL_TO_SLUG[label]) return ECOMMERCE_LABEL_TO_SLUG[label];
    // case-insensitive fallback
    const matchKey = Object.keys(ECOMMERCE_LABEL_TO_SLUG).find(
      (k) => k.toLowerCase() === label.toLowerCase()
    );
    if (matchKey) return ECOMMERCE_LABEL_TO_SLUG[matchKey];
  }
  return null;
}

/** AI brandProfile.productCategory (free text) → slug via keyword rules. */
function mapAiCategoryToSlug(productCategory) {
  const text = _coerceString(productCategory);
  if (!text) return null;
  for (const rule of AI_KEYWORD_RULES) {
    if (rule.test.test(text)) return rule.slug;
  }
  return null;
}

/** Wizard INDUSTRIES dropdown label → slug. */
function mapIndustryLabelToSlug(label) {
  const value = _coerceString(label);
  if (!value) return null;
  // exact match in signup labels first (Industry list overlaps Electronics, Fashion, ...)
  if (ECOMMERCE_LABEL_TO_SLUG[value]) return ECOMMERCE_LABEL_TO_SLUG[value];
  return mapAiCategoryToSlug(value);
}

/**
 * Resolve canonical slug using priority:
 *   explicit user pick (slug)  >  signup multi-select  >  AI brandProfile  >  industry text  >  DEFAULT_SLUG
 */
function resolveStoreCategorySlug({ userSlug, ecommerceCategories, aiProductCategory, industryLabel } = {}) {
  if (isKnownSlug(userSlug)) return userSlug;
  const fromSignup = mapOnboardingCategoriesToSlug(ecommerceCategories);
  if (fromSignup) return fromSignup;
  const fromAi = mapAiCategoryToSlug(aiProductCategory);
  if (fromAi) return fromAi;
  const fromIndustry = mapIndustryLabelToSlug(industryLabel);
  if (fromIndustry) return fromIndustry;
  return DEFAULT_SLUG;
}

module.exports = {
  DEFAULT_SLUG,
  STORE_CATEGORIES,
  isKnownSlug,
  getStoreCategoryBySlug,
  mapOnboardingCategoriesToSlug,
  mapAiCategoryToSlug,
  mapIndustryLabelToSlug,
  resolveStoreCategorySlug,
};
