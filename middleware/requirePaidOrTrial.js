'use strict';

/** Billing paywall removed (2026-06) — all authenticated API mutations allowed. */
function requirePaidOrTrial() {
  return (req, res, next) => next();
}

function isAllowlisted() {
  return true;
}

module.exports = { requirePaidOrTrial, isAllowlisted };
