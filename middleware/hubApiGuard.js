'use strict';

const { hubSectionAllowed, isWorkspaceAdmin } = require('../constants/hubSections');

/** API path prefix → hub section id (AGENT hub access enforcement). */
const API_HUB_RULES = [
  { prefix: '/api/conversations', sectionId: 'conversations' },
  { prefix: '/api/campaigns', sectionId: 'marketing-hub' },
  { prefix: '/api/sequences', sectionId: 'marketing-hub' },
  { prefix: '/api/flow-builder', sectionId: 'flow-builder' },
  { prefix: '/api/flows', sectionId: 'flow-builder' },
  { prefix: '/api/knowledge', sectionId: 'intelligence-hub' },
  { prefix: '/api/ai-wallet', sectionId: 'intelligence-hub' },
  { prefix: '/api/intent', sectionId: 'intelligence-hub' },
  { prefix: '/api/insights', sectionId: 'insights-hub' },
  { prefix: '/api/analytics', sectionId: 'insights-hub' },
  { prefix: '/api/leads', sectionId: 'audience-hub' },
  { prefix: '/api/segments', sectionId: 'audience-hub' },
  { prefix: '/api/abandoned-carts', sectionId: 'audience-hub' },
  { prefix: '/api/commerce-automations', sectionId: 'shopify-automation-center' },
  { prefix: '/api/orders', sectionId: 'orders' },
  { prefix: '/api/commerce', sectionId: 'commerce-hub' },
  { prefix: '/api/inventory', sectionId: 'commerce-hub' },
  { prefix: '/api/templates', sectionId: 'meta-manager' },
  { prefix: '/api/meta-templates', sectionId: 'meta-manager' },
  { prefix: '/api/whatsapp-flows', sectionId: 'meta-manager' },
  { prefix: '/api/auto-templates', sectionId: 'meta-manager' },
  { prefix: '/api/billing', sectionId: 'billing' },
  { prefix: '/api/settings', sectionId: 'settings' },
  { prefix: '/api/wizard', sectionId: 'settings' },
  { prefix: '/api/admin/my-settings', sectionId: 'settings' },
];

const EXEMPT_PREFIXES = [
  '/api/auth',
  '/api/team',
  '/api/workspace',
  '/api/health',
  '/api/webhook',
  '/api/dashboard',
  '/api/telemetry',
];

function resolveHubSectionForApi(path) {
  if (path === '/api/flow' || path.startsWith('/api/flow/')) {
    return 'flow-builder';
  }
  for (const rule of API_HUB_RULES) {
    const { prefix, sectionId } = rule;
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return sectionId;
    }
  }
  return null;
}

function hubApiGuard() {
  return (req, res, next) => {
    if (!req.user || isWorkspaceAdmin(req.user)) return next();

    const path = String(req.originalUrl || req.path || '').split('?')[0];
    if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) return next();

    const sectionId = resolveHubSectionForApi(path);
    if (!sectionId) return next();

    if (hubSectionAllowed(req.user, sectionId)) return next();

    return res.status(403).json({
      success: false,
      code: 'HUB_SECTION_FORBIDDEN',
      message: 'You do not have permission to manage this section.',
      sectionId,
    });
  };
}

module.exports = { hubApiGuard, resolveHubSectionForApi };
