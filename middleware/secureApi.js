'use strict';

const { protect } = require('./auth');
const { verifyTenantScope } = require('./verifyTenantScope');
const { requireRole, requireRoleCategory } = require('./requireRole');
const { requirePaidOrTrial } = require('./requirePaidOrTrial');
const { tenantRateLimit } = require('./tenantRateLimit');

/**
 * Standard authenticated API stack (Phase 5).
 */
function secureApi(scopeOpts = {}, ...roles) {
  const stack = [protect, tenantRateLimit(), requirePaidOrTrial()];
  if (scopeOpts !== false) {
    stack.push(verifyTenantScope(scopeOpts || {}));
  }
  if (roles.length) {
    stack.push(requireRole(...roles));
  }
  return stack;
}

module.exports = {
  secureApi,
  protect,
  verifyTenantScope,
  requireRole,
  requireRoleCategory,
  requirePaidOrTrial,
  tenantRateLimit,
};
