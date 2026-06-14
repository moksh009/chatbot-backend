'use strict';

const crypto = require('crypto');

/**
 * Deterministic 50/50 template bucket per clientId + lead + step (NEW-6).
 */
function pickAbTestTemplate({
  clientId,
  leadId,
  stepNum,
  templateA,
  templateB,
  abTestEnabled = false,
}) {
  const primary = String(templateA || '').trim();
  const variant = String(templateB || '').trim();
  if (!abTestEnabled || !primary || !variant || primary === variant) {
    return { templateName: primary, variant: 'A' };
  }

  const hash = crypto
    .createHash('md5')
    .update(`${clientId}:${leadId}:cart_step_${stepNum}`)
    .digest('hex');
  const bucket = parseInt(hash.slice(0, 8), 16) % 2;

  return bucket === 0
    ? { templateName: primary, variant: 'A' }
    : { templateName: variant, variant: 'B' };
}

function resolveAbTestTemplatesForSlot(cartRule, fallback) {
  const primary = (cartRule?.isActive && cartRule?.templateName) ? cartRule.templateName : fallback;
  const variantB = cartRule?.abTestTemplateName || cartRule?.meta?.abTestTemplateName || '';
  return { primary, variantB };
}

module.exports = { pickAbTestTemplate, resolveAbTestTemplatesForSlot };
