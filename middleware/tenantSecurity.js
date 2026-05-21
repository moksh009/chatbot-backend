"use strict";

const { assertTenantAccess } = require("../utils/queryHelpers");
const { auditSecurity } = require("./securityAudit");

/**
 * Express param guard — blocks cross-tenant IDOR on any route with :clientId.
 * Mount via router.param('clientId', ...) or app.use('/api/settings', enforceTenantFromParams).
 */
function enforceTenantParam(req, res, next, clientId) {
  const gate = assertTenantAccess(req, clientId);
  if (!gate.ok) {
    auditSecurity("TENANT_ACCESS_DENIED", {
      req,
      userId: req.user?._id,
      userEmail: req.user?.email,
      tenantId: req.user?.clientId,
      targetClientId: clientId,
      reason: gate.message,
    });
    return res.status(gate.status).json({ success: false, message: gate.message });
  }
  req.tenantId = gate.tenantId;
  next();
}

/** Reject body/query clientId that does not match authenticated tenant (non–super-admin). */
function enforceTenantBodyClientId(req, res, next) {
  if (!req.user) return next();
  if (req.user.role === "SUPER_ADMIN") return next();

  const bodyId = req.body?.clientId;
  const queryId = req.query?.clientId;
  const tenantId = req.user.clientId;

  for (const supplied of [bodyId, queryId]) {
    if (supplied && String(supplied).trim() && String(supplied).trim() !== String(tenantId)) {
      auditSecurity("TENANT_BODY_SPOOF_BLOCKED", {
        req,
        tenantId,
        targetClientId: supplied,
        reason: "clientId in body/query does not match session",
      });
      return res.status(403).json({
        success: false,
        message: "Cannot access another workspace from this account",
      });
    }
  }
  next();
}

/**
 * Merge tenant scope into Mongo queries — always include clientId for non–super-admin.
 */
function scopedClientFilter(req, extra = {}) {
  const tenantId = req.tenantId || req.user?.clientId;
  if (!tenantId) return extra;
  return { ...extra, clientId: tenantId };
}

module.exports = {
  enforceTenantParam,
  enforceTenantBodyClientId,
  scopedClientFilter,
};
