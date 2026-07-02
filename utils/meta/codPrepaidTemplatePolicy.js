'use strict';

const { isSystemExcluded } = require('./templatePolicy');

function normalizeStatus(template) {
  const value = String(template?.status || template?.submissionStatus || '').toUpperCase();
  if (value === 'APPROVED') return 'APPROVED';
  if (value === 'REJECTED') return 'REJECTED';
  if (['PENDING', 'QUEUED', 'SUBMITTING'].includes(value)) return 'PENDING';
  return value || 'DRAFT';
}

function templateCategory(template) {
  return String(template?.category || template?.metaCategory || '').toUpperCase();
}

/** Approved MARKETING + UTILITY templates for COD → Prepaid journey picker. */
function filterTemplatesForCodPrepaidPicker(list) {
  return (Array.isArray(list) ? list : []).filter((tpl) => {
    if (isSystemExcluded(tpl)) return false;
    if (normalizeStatus(tpl) !== 'APPROVED') return false;
    const cat = templateCategory(tpl);
    return cat === 'MARKETING' || cat === 'UTILITY';
  });
}

module.exports = {
  filterTemplatesForCodPrepaidPicker,
};
