"use strict";

const MAX_PRODUCTS = 120;
const MAX_TEMPLATES = 80;
const MAX_STRING = 12000;

/** Strip bulky / irrelevant fields before persisting wizard step buckets. */
function sanitizeWizardStepData(stepId, raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  const data = { ...raw };

  if (stepId !== "products") {
    delete data.products;
  } else if (Array.isArray(data.products)) {
    data.products = data.products.slice(0, MAX_PRODUCTS);
  }

  if (stepId !== "templates") {
    delete data.selectedTemplates;
    delete data.customTemplates;
  } else {
    if (Array.isArray(data.selectedTemplates)) {
      data.selectedTemplates = data.selectedTemplates.slice(0, MAX_TEMPLATES);
    }
    if (Array.isArray(data.customTemplates)) {
      data.customTemplates = data.customTemplates.slice(0, MAX_TEMPLATES);
    }
  }

  // Never persist flow graph blobs on step save
  delete data.flowPreview;
  delete data.generatedFlow;
  delete data.publishedNodes;

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string" && value.length > MAX_STRING) {
      data[key] = value.slice(0, MAX_STRING);
    }
  }

  return data;
}

module.exports = { sanitizeWizardStepData };
