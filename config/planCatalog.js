'use strict';

/**
 * Legacy plan catalog stub — SaaS billing removed pending commercial rebuild (2026-06).
 * Exports unchanged symbols so callers compile; all limits and hub gates are unrestricted.
 */

const UNLIMITED_LIMITS = {
  contacts: -1,
  messages: -1,
  agents: -1,
  campaigns: -1,
  flows: -1,
  sequences: true,
  instagram: true,
  analyticsdays: 365,
  waflows: true,
  aiSegments: true,
  aiCalls: -1,
};

const FULL_ACCESS = {
  hubs: { marketing: true, automation: true, commerce: true },
  intelligenceV2: true,
};

const PAID_SLUGS = [];
const LEGACY_PLAN_MAP = {};
const PLAN_LIMITS = { trial: UNLIMITED_LIMITS, unlimited: UNLIMITED_LIMITS };
const PLAN_CHECKOUT = [];
const PLAN_ACCESS = { trial: FULL_ACCESS, unlimited: FULL_ACCESS };

function normalizePlanSlug() {
  return 'unlimited';
}

function resolvePlanLimits() {
  return UNLIMITED_LIMITS;
}

function resolveRequestedPlan() {
  return null;
}

function getCheckoutMeta() {
  return null;
}

function getRazorpayPlanIdFromEnv() {
  return null;
}

function getPlanAccessSnapshot() {
  return { slug: 'unlimited', ...FULL_ACCESS };
}

function isPaidPlanSlug() {
  return true;
}

function buildPlanAccessBundle() {
  return { billingPlanSlug: 'unlimited', ...FULL_ACCESS };
}

function formatInr(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return '₹0';
  return `₹${(n / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

module.exports = {
  PAID_SLUGS,
  LEGACY_PLAN_MAP,
  PLAN_LIMITS,
  PLAN_CHECKOUT,
  PLAN_ACCESS,
  normalizePlanSlug,
  resolvePlanLimits,
  resolveRequestedPlan,
  getCheckoutMeta,
  getRazorpayPlanIdFromEnv,
  getPlanAccessSnapshot,
  isPaidPlanSlug,
  buildPlanAccessBundle,
  formatInr,
};
