'use strict';

const { auditLog } = require('../services/audit/auditWriter');
const { resolveTargetClientId } = require('../utils/security/resolveTargetClientId');
const { tenantClientId } = require('../utils/core/queryHelpers');
const { canImpersonateMerchants } = require('./adminAccess');

/**
 * Tenant scope enforcement (Phase 5 A2).
 * SUPER_ADMIN and authorized admin-team impersonation bypass.
 */
function verifyTenantScope(opts = {}) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'unauthorized' });
      if (req.user.role === 'SUPER_ADMIN') return next();

      const targetClientId = await resolveTargetClientId(req, opts);
      if (!targetClientId) return next();

      if (canImpersonateMerchants(req.user)) {
        const resolved = tenantClientId(req);
        if (resolved && String(resolved) === String(targetClientId)) {
          req.tenantId = resolved;
          return next();
        }
      }

      if (String(targetClientId) !== String(req.user.clientId)) {
        auditLog({
          category: 'security',
          action: 'unauthorized_cross_tenant_attempt',
          severity: 'high',
          clientId: req.user.clientId,
          actor: {
            type: 'user',
            userId: req.user._id || req.user.id,
            source: 'api',
            ip: req.ip,
            userAgent: req.get('user-agent'),
          },
          details: {
            attempted: targetClientId,
            allowed: req.user.clientId,
            path: req.originalUrl,
            method: req.method,
          },
        });
        return res.status(403).json({ error: 'forbidden' });
      }
      req.tenantId = req.user.clientId;
      return next();
    } catch (e) {
      return res.status(500).json({ error: 'tenant_scope_error' });
    }
  };
}

module.exports = { verifyTenantScope };
