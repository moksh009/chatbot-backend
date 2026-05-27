'use strict';

const MetaTemplate = require('../../models/MetaTemplate');
const { getPrebuiltByKey } = require('../../constants/prebuiltTemplateLibrary');
const log = require('../core/logger')('CartRecoveryDrafts');

const CART_DRAFT_SPECS = [
  {
    name: 'cart_recovery_1',
    catalogSlotId: 'wizard_cart_1',
    templateKey: 'cart_recovery_1',
    prebuiltKey: 'abandoned_cart_r1_v1',
    step: 1,
  },
  {
    name: 'cart_recovery_2',
    catalogSlotId: 'wizard_cart_2',
    templateKey: 'cart_recovery_2',
    prebuiltKey: 'abandoned_cart_r2_v1',
    step: 2,
  },
  {
    name: 'cart_recovery_3',
    catalogSlotId: 'wizard_cart_3',
    templateKey: 'cart_recovery_3',
    prebuiltKey: 'abandoned_cart_r3_v1',
    step: 3,
    bodyText:
      'Hi {{1}}, last chance to get {{2}} (₹{{3}})! Here\'s a special offer — use code {{5}} for 10% off.\n\nTap below to complete your order 👇',
    headerType: 'IMAGE',
    buttons: [{ type: 'URL', text: 'Use Offer Now', urlVariable: 'checkout_url' }],
    variableMappings: {
      body: { 1: 'first_name', 2: 'product_name', 3: 'cart_total', 5: 'discount_code' },
      buttons: { 0: 'checkout_url' },
    },
  },
];

function draftFromPrebuilt(prebuilt, spec) {
  return {
    name: spec.name,
    internalName: prebuilt.displayName,
    category: prebuilt.category || 'MARKETING',
    language: 'en',
    headerType: prebuilt.headerType || 'IMAGE',
    headerValue: '',
    body: prebuilt.bodyText,
    buttons: prebuilt.buttons || [],
    formData: {
      bodyText: prebuilt.bodyText,
      mediaSample: prebuilt.headerType === 'IMAGE' ? 'Image' : 'None',
    },
    variableMappings: prebuilt.variableMappings,
    templateKey: spec.templateKey,
    catalogSlotId: spec.catalogSlotId,
    autoTrigger: 'abandoned_cart',
    source: 'wizard_automation',
    templateKind: 'prebuilt',
    isPrebuilt: true,
    submissionStatus: 'draft',
    primaryPurpose: 'sequence',
  };
}

/**
 * Create draft Meta templates for the 3-step cart recovery ladder when abandoned_cart goal is enabled.
 */
async function createCartRecoveryTemplateDrafts(clientId, brandName = 'our store') {
  if (!clientId) return { created: 0, skipped: 0 };

  let created = 0;
  let skipped = 0;

  for (const spec of CART_DRAFT_SPECS) {
    const existing = await MetaTemplate.findOne({ clientId, name: spec.name }).lean();
    if (existing) {
      skipped += 1;
      continue;
    }

    let doc;
    if (spec.prebuiltKey) {
      const prebuilt = getPrebuiltByKey(spec.prebuiltKey);
      if (!prebuilt) {
        log.warn(`Prebuilt ${spec.prebuiltKey} missing — skip ${spec.name}`);
        skipped += 1;
        continue;
      }
      doc = draftFromPrebuilt(prebuilt, spec);
    } else {
      doc = {
        name: spec.name,
        internalName: `Abandoned cart — reminder ${spec.step}`,
        category: 'MARKETING',
        language: 'en',
        headerType: spec.headerType || 'IMAGE',
        body: spec.bodyText,
        buttons: spec.buttons || [],
        formData: { bodyText: spec.bodyText, mediaSample: 'Image' },
        variableMappings: spec.variableMappings,
        templateKey: spec.templateKey,
        catalogSlotId: spec.catalogSlotId,
        autoTrigger: 'abandoned_cart',
        source: 'wizard_automation',
        templateKind: 'prebuilt',
        isPrebuilt: true,
        submissionStatus: 'draft',
        primaryPurpose: 'sequence',
      };
    }

    doc.clientId = clientId;
    await MetaTemplate.create(doc);
    created += 1;
  }

  log.info(`Cart recovery drafts for ${clientId}: created=${created} skipped=${skipped}`);
  return { created, skipped };
}

module.exports = { createCartRecoveryTemplateDrafts, CART_DRAFT_SPECS };
