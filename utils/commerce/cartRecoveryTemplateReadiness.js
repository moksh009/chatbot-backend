'use strict';

const CART_TEMPLATE_KEYS = ['cart_recovery_1', 'cart_recovery_2', 'cart_recovery_3'];

function resolveTemplateStatus(templateName, syncedTemplates = []) {
  const synced = syncedTemplates.find((t) => String(t?.name || '') === templateName);
  if (!synced) return 'missing';
  const st = String(synced.status || '').toUpperCase();
  if (st === 'APPROVED' || st === 'ACTIVE') return 'approved';
  if (st === 'REJECTED') return 'rejected';
  return 'pending';
}

function buildCartRecoveryTemplateReadiness(client = {}) {
  const synced = Array.isArray(client.syncedMetaTemplates) ? client.syncedMetaTemplates : [];
  const automations = Array.isArray(client.commerceAutomations) ? client.commerceAutomations : [];
  const cartRules = automations.filter((a) => a.meta?.category === 'abandoned_cart');

  const templates = CART_TEMPLATE_KEYS.map((name) => {
    const rule = cartRules.find((r) => r.meta?.systemSlot === `followup_${name.replace(/\D/g, '')}`);
    return {
      name,
      slotId: name,
      status: resolveTemplateStatus(name, synced),
      ruleActive: rule?.isActive === true,
      ruleId: rule?.id || `sys_cart_followup_${name.replace(/\D/g, '')}`,
      channels: Array.isArray(rule?.channels) ? rule.channels : ['whatsapp'],
    };
  });

  const approvedCount = templates.filter((t) => t.status === 'approved').length;
  const activeCount = templates.filter((t) => t.ruleActive).length;

  return {
    templates,
    approvedCount,
    activeCount,
    allApproved: approvedCount === 3,
    readyToSend: approvedCount >= 1 && activeCount >= 1,
    missingCount: templates.filter((t) => t.status === 'missing').length,
    pendingCount: templates.filter((t) => t.status === 'pending').length,
  };
}

module.exports = { buildCartRecoveryTemplateReadiness, CART_TEMPLATE_KEYS };
