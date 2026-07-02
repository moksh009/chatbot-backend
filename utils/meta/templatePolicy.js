'use strict';

/** Meta sample / system templates — never offer in merchant pickers */
const SYSTEM_EXCLUDED_NAMES = new Set(['hello_world', 'hello world']);

const PURPOSES = ['campaign', 'sequence', 'order_status', 'cart_recovery', 'bot_reply', 'flow', 'ig', 'utility', 'cod_prepaid'];

function normalizePurpose(input, fallback = 'utility') {
  const value = String(input || fallback).trim().toLowerCase();
  return PURPOSES.includes(value) ? value : fallback;
}

function normalizeStatus(template) {
  const value = String(template?.status || template?.submissionStatus || '').toUpperCase();
  if (value === 'APPROVED') return 'APPROVED';
  if (value === 'REJECTED') return 'REJECTED';
  if (['PENDING', 'QUEUED', 'SUBMITTING'].includes(value)) return 'PENDING';
  return value || 'DRAFT';
}

function isSystemExcluded(template) {
  const name = String(template?.name || '').trim().toLowerCase();
  return SYSTEM_EXCLUDED_NAMES.has(name);
}

function templateCategory(template) {
  return String(template?.category || template?.metaCategory || '').toUpperCase();
}

function primaryPurpose(template) {
  return normalizePurpose(template?.primaryPurpose || 'utility');
}

function secondaryPurposes(template) {
  return Array.isArray(template?.secondaryPurposes)
    ? template.secondaryPurposes.map((p) => normalizePurpose(p))
    : [];
}

function hasPurpose(template, purpose) {
  const p = normalizePurpose(purpose);
  const primary = primaryPurpose(template);
  const secondary = secondaryPurposes(template);
  return primary === p || secondary.includes(p);
}

function isCampaignEligible(template) {
  if (isSystemExcluded(template)) return false;
  if (normalizeStatus(template) !== 'APPROVED') return false;
  // Any approved Meta MARKETING template can power broadcasts (purpose tags are optional).
  return templateCategory(template) === 'MARKETING';
}

function isSequenceEligible(template) {
  if (isSystemExcluded(template)) return false;
  if (normalizeStatus(template) !== 'APPROVED') return false;
  const cat = templateCategory(template);
  if (!['MARKETING', 'UTILITY'].includes(cat)) return false;
  return hasPurpose(template, 'sequence') || cat === 'UTILITY' || cat === 'MARKETING';
}

function isOrderMessageEligible(template) {
  if (isSystemExcluded(template)) return false;
  const { isWizardProductTemplate, isOrderMessageTemplateName } = require('./orderMessageTemplatePolicy');
  if (isWizardProductTemplate(template)) return false;
  if (isOrderMessageTemplateName(template?.name)) return normalizeStatus(template) === 'APPROVED';
  if (normalizeStatus(template) !== 'APPROVED') return false;
  if (templateCategory(template) !== 'UTILITY') return false;
  return hasPurpose(template, 'order_status');
}

function isCartRecoveryEligible(template) {
  if (isSystemExcluded(template)) return false;
  const name = String(template?.name || '').toLowerCase();
  if (name.includes('cart_recovery') || name.includes('abandon')) return true;
  if (hasPurpose(template, 'cart_recovery')) return true;
  if (templateCategory(template) === 'MARKETING' && name.includes('cart')) return true;
  return false;
}

function filterTemplatesForContext(templates, contextPurpose) {
  const raw = String(contextPurpose || '').trim().toLowerCase();
  const aliasMap = { 'order-messages': 'order_status', order_messages: 'order_status' };
  const purpose = normalizePurpose(aliasMap[raw] || raw, 'campaign');
  const list = Array.isArray(templates) ? templates : [];
  const approved = list.filter((t) => normalizeStatus(t) === 'APPROVED' && !isSystemExcluded(t));

  let eligible;
  if (purpose === 'campaign') {
    eligible = approved.filter(isCampaignEligible);
  } else if (purpose === 'sequence') {
    eligible = approved.filter(isSequenceEligible);
  } else if (purpose === 'order_status') {
    const { filterTemplatesForOrderMessagesList } = require('./orderMessageTemplatePolicy');
    eligible = filterTemplatesForOrderMessagesList(list);
  } else if (purpose === 'cart_recovery') {
    const { filterTemplatesForCartRecoveryList } = require('./orderMessageTemplatePolicy');
    eligible = filterTemplatesForCartRecoveryList(list);
    if (!eligible.length) {
      eligible = list.filter((t) => !isSystemExcluded(t) && isCartRecoveryEligible(t));
    }
  } else if (purpose === 'cod_prepaid') {
    const { filterTemplatesForCodPrepaidPicker } = require('./codPrepaidTemplatePolicy');
    eligible = filterTemplatesForCodPrepaidPicker(list);
  } else {
    eligible = approved.filter((t) => hasPurpose(t, purpose) || primaryPurpose(t) === purpose);
  }

  const hidden = {
    systemExcluded: list.filter(isSystemExcluded).length,
    notApproved: list.filter((t) => normalizeStatus(t) !== 'APPROVED').length,
    wrongCategory: approved.length - eligible.length,
  };

  return { eligible, hidden, approvedTotal: approved.length, syncedTotal: list.length };
}

function defaultPrimaryPurposeForCreate({ category, name }) {
  const cat = String(category || '').toUpperCase();
  const n = String(name || '').toLowerCase();
  if (cat === 'MARKETING') return 'campaign';
  if (cat === 'AUTHENTICATION') return 'bot_reply';
  if (n.includes('eco_') || n.includes('order')) return 'order_status';
  if (n.includes('cart') || n.includes('abandon')) return 'cart_recovery';
  if (cat === 'UTILITY') return 'order_status';
  return 'bot_reply';
}

module.exports = {
  SYSTEM_EXCLUDED_NAMES,
  normalizePurpose,
  isSystemExcluded,
  isCampaignEligible,
  isSequenceEligible,
  isOrderMessageEligible,
  isCartRecoveryEligible,
  filterTemplatesForContext,
  defaultPrimaryPurposeForCreate,
};
