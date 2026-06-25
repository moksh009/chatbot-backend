'use strict';

/** Plan gate removed (2026-06) — Intelligence Hub open for all tenants. */
function requireIntelligenceV2() {
  return (req, res, next) => next();
}

module.exports = { requireIntelligenceV2 };
