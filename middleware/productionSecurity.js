"use strict";

/**
 * Production hardening — disable dev-only auth bypasses and enforce strict modes.
 */

function isProduction() {
  return process.env.NODE_ENV === "production";
}

function isStrictSecurity() {
  return (
    isProduction() ||
    process.env.SECURITY_STRICT === "true" ||
    process.env.ENFORCE_PRODUCTION_SECURITY === "true"
  );
}

/** Optional env-gated bypass — no hardcoded emails (Phase 5). */
function hasMasterTesterBypass(user) {
  if (!user?.email || process.env.ALLOW_MASTER_TESTER_BYPASS !== 'true') return false;
  const allowed = String(process.env.MASTER_TESTER_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(String(user.email).toLowerCase());
}

function requireJwtSecret() {
  if (!process.env.JWT_SECRET || String(process.env.JWT_SECRET).length < 32) {
    if (isStrictSecurity()) {
      throw new Error(
        "FATAL: JWT_SECRET must be set and at least 32 characters in production"
      );
    }
  }
}

module.exports = {
  isProduction,
  isStrictSecurity,
  hasMasterTesterBypass,
  requireJwtSecret,
};
