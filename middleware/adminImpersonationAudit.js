'use strict';

const AuditLog = require('../models/AuditLog');
const { canImpersonateMerchants } = require('./adminAccess');

/** Log platform admin actions performed while impersonating a tenant workspace. */
function adminImpersonationAudit(req, res, next) {
  const impersonating = req.headers['x-admin-impersonating'];
  if (!impersonating || !canImpersonateMerchants(req.user)) return next();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const clientId = String(impersonating).trim();
  if (!clientId) return next();

  AuditLog.create({
    clientId,
    category: 'admin_impersonation',
    action_type: 'IMPERSONATION_ACTION',
    severity: 'warning',
    actor: {
      type: req.user?.role === 'SUPER_ADMIN' ? 'super_admin' : 'admin_team',
      userId: req.user._id,
      source: 'dashboard',
    },
    payload: {
      method: req.method,
      path: req.originalUrl || req.path,
      adminEmail: req.user.email,
    },
  }).catch(() => {});

  return next();
}

module.exports = { adminImpersonationAudit };
