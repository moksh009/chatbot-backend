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

/** Master tester email bypass — disabled in production unless explicitly allowed. */
function hasMasterTesterBypass(user) {
  if (!user?.email) return false;
  if (!isStrictSecurity()) {
    return user.email === "delitech2708@gmail.com";
  }
  return process.env.ALLOW_MASTER_TESTER_BYPASS === "true" && user.email === "delitech2708@gmail.com";
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
