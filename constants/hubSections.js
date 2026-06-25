'use strict';

const HUB_SECTIONS = [
  { id: 'dashboard', path: '/' },
  { id: 'conversations', path: '/conversations' },
  { id: 'intelligence-hub', path: '/intelligence-hub' },
  { id: 'insights-hub', path: '/insights-hub' },
  { id: 'audience-hub', path: '/audience-hub' },
  { id: 'marketing-hub', path: '/marketing-hub' },
  { id: 'automation-hub', path: '/automation-hub' },
  { id: 'flow-builder', path: '/flow-builder' },
  { id: 'orders', path: '/orders' },
  { id: 'commerce-hub', path: '/commerce-hub' },
  { id: 'shopify-automation-center', path: '/shopify-automation-center' },
  { id: 'meta-manager', path: '/meta-manager' },
  { id: 'settings', path: '/settings' },
];

const VALID_SECTION_IDS = new Set(HUB_SECTIONS.map((s) => s.id));

const DEFAULT_AGENT_HUB_ACCESS = ['conversations'];

function isWorkspaceAdmin(user) {
  const role = String(user?.role || '').toUpperCase();
  return role === 'CLIENT_ADMIN' || role === 'SUPER_ADMIN';
}

function sanitizeHubAccess(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(String).filter((id) => VALID_SECTION_IDS.has(id)))];
}

function normalizedHubAccess(user) {
  if (!user || isWorkspaceAdmin(user)) return [...VALID_SECTION_IDS];
  const raw = sanitizeHubAccess(user.hubAccess);
  return raw.length ? raw : [...DEFAULT_AGENT_HUB_ACCESS];
}

function hubSectionAllowed(user, sectionId) {
  if (!user) return false;
  if (isWorkspaceAdmin(user)) return true;
  if (!sectionId || !VALID_SECTION_IDS.has(sectionId)) return true;
  return normalizedHubAccess(user).includes(sectionId);
}

module.exports = {
  HUB_SECTIONS,
  VALID_SECTION_IDS,
  DEFAULT_AGENT_HUB_ACCESS,
  sanitizeHubAccess,
  normalizedHubAccess,
  hubSectionAllowed,
  isWorkspaceAdmin,
};
