'use strict';

/**
 * Phase 1.7 — Mapping + merge tests for the store-category SSOT.
 *
 * Locks in:
 *   - signup multi-select label → slug
 *   - AI productCategory keyword fallback
 *   - merchant override priority
 *   - preset merge defaults flip warranty/install for the right vertical
 *   - categoryOverrides override preset even when slug says otherwise
 *
 * Run: `node --test tests/storeCategories.test.js`
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SLUG,
  STORE_CATEGORIES,
  isKnownSlug,
  getStoreCategoryBySlug,
  mapOnboardingCategoriesToSlug,
  mapAiCategoryToSlug,
  mapIndustryLabelToSlug,
  resolveStoreCategorySlug,
} = require('../constants/storeCategories');

const { mergeWizardFeatures } = require('../utils/flow/wizardFeaturePresets');

test('DEFAULT_SLUG is a recognized slug', () => {
  assert.equal(DEFAULT_SLUG, 'general_d2c');
  assert.ok(isKnownSlug(DEFAULT_SLUG));
});

test('STORE_CATEGORIES is non-empty and every entry has slug+label+presetKey', () => {
  assert.ok(STORE_CATEGORIES.length >= 8);
  for (const cat of STORE_CATEGORIES) {
    assert.ok(cat.slug, `missing slug: ${JSON.stringify(cat)}`);
    assert.ok(cat.label, `missing label: ${cat.slug}`);
    assert.ok(cat.presetKey, `missing presetKey: ${cat.slug}`);
  }
});

test('mapOnboardingCategoriesToSlug — signup label exact match', () => {
  assert.equal(mapOnboardingCategoriesToSlug(['Fashion & Clothing']), 'fashion_apparel');
  assert.equal(mapOnboardingCategoriesToSlug(['Electronics']), 'electronics_smart_home');
  assert.equal(mapOnboardingCategoriesToSlug(['Beauty & Skincare']), 'beauty_personal_care');
  assert.equal(mapOnboardingCategoriesToSlug(['Food & Beverages']), 'food_beverage');
  assert.equal(mapOnboardingCategoriesToSlug(['Jewellery']), 'jewellery_accessories');
  assert.equal(mapOnboardingCategoriesToSlug(['Toys & Games']), 'toys_games');
  assert.equal(mapOnboardingCategoriesToSlug(['Other']), 'general_d2c');
});

test('mapOnboardingCategoriesToSlug — case-insensitive fallback', () => {
  assert.equal(mapOnboardingCategoriesToSlug(['fashion & clothing']), 'fashion_apparel');
  assert.equal(mapOnboardingCategoriesToSlug(['ELECTRONICS']), 'electronics_smart_home');
});

test('mapOnboardingCategoriesToSlug — first match wins', () => {
  assert.equal(
    mapOnboardingCategoriesToSlug(['Beauty & Skincare', 'Electronics']),
    'beauty_personal_care'
  );
});

test('mapOnboardingCategoriesToSlug — empty/garbage returns null', () => {
  assert.equal(mapOnboardingCategoriesToSlug([]), null);
  assert.equal(mapOnboardingCategoriesToSlug(['totally-made-up-category']), null);
  assert.equal(mapOnboardingCategoriesToSlug(null), null);
});

test('mapAiCategoryToSlug — keyword rules cover key verticals', () => {
  assert.equal(mapAiCategoryToSlug('smart doorbell sensor'), 'electronics_smart_home');
  assert.equal(mapAiCategoryToSlug('designer kurta saree boutique'), 'fashion_apparel');
  assert.equal(mapAiCategoryToSlug('organic skincare cream'), 'beauty_personal_care');
  assert.equal(mapAiCategoryToSlug('artisan dark chocolate bars'), 'food_beverage');
  assert.equal(mapAiCategoryToSlug('yoga and fitness gear'), 'sports_fitness');
  assert.equal(mapAiCategoryToSlug('salon and spa services'), 'services_local');
});

test('mapAiCategoryToSlug — unknown free text returns null', () => {
  assert.equal(mapAiCategoryToSlug('Lorem ipsum nothing relevant'), null);
  assert.equal(mapAiCategoryToSlug(''), null);
  assert.equal(mapAiCategoryToSlug(null), null);
});

test('mapIndustryLabelToSlug — falls back to AI keyword rules', () => {
  assert.equal(mapIndustryLabelToSlug('Electronics'), 'electronics_smart_home');
  assert.equal(mapIndustryLabelToSlug('Shoes & Footwear'), 'fashion_apparel');
  // free-text industry label still classified via keyword rules
  assert.equal(mapIndustryLabelToSlug('Smart home gadgets'), 'electronics_smart_home');
});

test('resolveStoreCategorySlug — explicit userSlug wins', () => {
  assert.equal(
    resolveStoreCategorySlug({
      userSlug: 'health_wellness',
      ecommerceCategories: ['Fashion & Clothing'],
      aiProductCategory: 'doorbell',
    }),
    'health_wellness'
  );
});

test('resolveStoreCategorySlug — signup multi-select beats AI', () => {
  assert.equal(
    resolveStoreCategorySlug({
      ecommerceCategories: ['Fashion & Clothing'],
      aiProductCategory: 'doorbell',
    }),
    'fashion_apparel'
  );
});

test('resolveStoreCategorySlug — AI beats industry text', () => {
  assert.equal(
    resolveStoreCategorySlug({
      aiProductCategory: 'smart doorbell',
      industryLabel: 'Other',
    }),
    'electronics_smart_home'
  );
});

test('resolveStoreCategorySlug — falls back to default', () => {
  assert.equal(resolveStoreCategorySlug({}), DEFAULT_SLUG);
  assert.equal(resolveStoreCategorySlug({ ecommerceCategories: ['Mystery'] }), DEFAULT_SLUG);
});

test('mergeWizardFeatures — fashion slug turns warranty + install off', () => {
  const out = mergeWizardFeatures({}, '', '', { storeCategory: 'fashion_apparel' });
  assert.equal(out.enableWarranty, false);
  assert.equal(out.enableInstallSupport, false);
  assert.equal(out.enableCatalog, true);
});

test('mergeWizardFeatures — electronics slug turns warranty + install on', () => {
  const out = mergeWizardFeatures({}, '', '', { storeCategory: 'electronics_smart_home' });
  assert.equal(out.enableWarranty, true);
  assert.equal(out.enableInstallSupport, true);
});

test('mergeWizardFeatures — services slug skips catalog', () => {
  const out = mergeWizardFeatures({}, '', '', { storeCategory: 'services_local' });
  assert.equal(out.enableCatalog, false);
  assert.equal(out.enableOrderTracking, false);
  assert.equal(out.enableFAQ, true);
  assert.equal(out.enableSupportEscalation, true);
});

test('mergeWizardFeatures — explicit user true beats fashion preset', () => {
  const out = mergeWizardFeatures(
    { enableWarranty: true },
    '',
    '',
    { storeCategory: 'fashion_apparel' }
  );
  assert.equal(out.enableWarranty, true);
});

test('mergeWizardFeatures — categoryOverrides.force_on always wins', () => {
  const out = mergeWizardFeatures(
    { enableWarranty: false },
    '',
    '',
    {
      storeCategory: 'fashion_apparel',
      categoryOverrides: { warranty: 'force_on' },
    }
  );
  assert.equal(out.enableWarranty, true);
});

test('mergeWizardFeatures — categoryOverrides.force_off always wins', () => {
  const out = mergeWizardFeatures(
    { enableInstallSupport: true },
    '',
    '',
    {
      storeCategory: 'electronics_smart_home',
      categoryOverrides: { install: 'force_off' },
    }
  );
  assert.equal(out.enableInstallSupport, false);
});

test('mergeWizardFeatures — unknown slug falls back to legacy normalization', () => {
  const out = mergeWizardFeatures({}, 'electronics', '', { storeCategory: 'bogus_slug' });
  assert.equal(out.enableWarranty, true); // electronics legacy preset
});

test('getStoreCategoryBySlug — returns default for unknown slug', () => {
  const def = getStoreCategoryBySlug('not-a-real-slug');
  assert.equal(def.slug, DEFAULT_SLUG);
});
