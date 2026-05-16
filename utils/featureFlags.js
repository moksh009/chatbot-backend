'use strict';

function wizardFeatures(client) {
  if (!client) return {};
  const wf = client.wizardFeatures;
  if (wf && typeof wf.toObject === 'function') return wf.toObject();
  return wf && typeof wf === 'object' ? wf : {};
}

function isReviewCollectionEnabled(client) {
  const wf = wizardFeatures(client);
  return (
    wf.enableReviewCollection === true ||
    client?.onboardingData?.features?.enableReviewCollection === true
  );
}

function isWarrantyEnabled(client) {
  const wf = wizardFeatures(client);
  return (
    wf.enableWarranty === true ||
    wf.warranty?.enabled === true ||
    client?.onboardingData?.features?.enableWarranty === true
  );
}

function isLoyaltyEnabled(client) {
  const lc = client?.loyaltyConfig || {};
  const wf = wizardFeatures(client);
  return (
    lc.isEnabled === true ||
    lc.enabled === true ||
    wf.enableLoyalty === true
  );
}

module.exports = {
  isReviewCollectionEnabled,
  isWarrantyEnabled,
  isLoyaltyEnabled,
};
