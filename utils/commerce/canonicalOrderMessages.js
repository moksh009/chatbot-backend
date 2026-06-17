'use strict';

/** True when tenant uses Jun 2026 SAC order-message rules (sys_* presets). */
function usesCanonicalOrderMessages(client) {
  const rules = Array.isArray(client?.commerceAutomations) ? client.commerceAutomations : [];
  return rules.some(
    (r) =>
      r?.meta?.category === 'order_notification' &&
      String(r.id || '').startsWith('sys_') &&
      r.isActive === true
  );
}

/** Global kill-switch for legacy `dispatchOrderStatusAutomation` (nicheData template map). */
function isCommerceCanonicalOnlyEnabled() {
  return String(process.env.COMMERCE_CANONICAL_ONLY || '').toLowerCase() === 'true';
}

/**
 * When true, skip legacy order dispatch — canonical handlers own WhatsApp sends.
 */
function shouldSkipLegacyOrderDispatch(client) {
  return isCommerceCanonicalOnlyEnabled() || usesCanonicalOrderMessages(client);
}

function isActiveOrderRule(client, ruleId) {
  const rules = Array.isArray(client?.commerceAutomations) ? client.commerceAutomations : [];
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule || rule.isActive !== true) return false;
  const channels = Array.isArray(rule.channels) ? rule.channels : ['whatsapp'];
  if (channels.includes('whatsapp') && rule.templateName) return true;
  if (channels.includes('email') && rule.emailConfig?.templateId) return true;
  return false;
}

function isCodShopifyOrder(payload = {}) {
  const gateways = payload.payment_gateway_names || [];
  if (gateways.some((g) => /cod|cash\s*on\s*delivery/i.test(String(g)))) return true;
  const gw = String(payload.gateway || payload.processing_method || '').toLowerCase();
  return gw.includes('cod') || gw.includes('cash on delivery');
}

module.exports = {
  usesCanonicalOrderMessages,
  isCommerceCanonicalOnlyEnabled,
  shouldSkipLegacyOrderDispatch,
  isActiveOrderRule,
  isCodShopifyOrder,
};
