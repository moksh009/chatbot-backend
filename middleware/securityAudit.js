"use strict";

/**
 * Structured security audit logging — tamper-evident console + optional persistence.
 * Use for auth failures, tenant isolation denials, privilege attempts, and admin actions.
 */

const log = require('../utils/core/logger')("SecurityAudit");

function redact(value) {
  if (value == null) return value;
  const s = String(value);
  if (s.length <= 4) return "***";
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

/**
 * @param {string} event - e.g. AUTH_LOGIN_FAILED, TENANT_ACCESS_DENIED
 * @param {object} meta
 */
function auditSecurity(event, meta = {}) {
  const payload = {
    event,
    at: new Date().toISOString(),
    ip: meta.ip || meta.req?.ip,
    method: meta.req?.method,
    path: meta.req?.originalUrl || meta.req?.path,
    userId: meta.userId || meta.req?.user?._id?.toString(),
    userEmail: meta.userEmail || meta.req?.user?.email,
    tenantId: meta.tenantId,
    targetClientId: meta.targetClientId,
    reason: meta.reason,
    ...meta.extra,
  };

  if (meta.email) payload.email = redact(meta.email);
  if (meta.clientId) payload.clientId = meta.clientId;

  const level =
    event.includes("DENIED") ||
    event.includes("FAILED") ||
    event.includes("BLOCKED") ||
    event.includes("SUSPICIOUS")
      ? "warn"
      : "info";

  log[level](JSON.stringify(payload));

  if (process.env.SECURITY_AUDIT_PERSIST === "true") {
    setImmediate(() => {
      try {
        const SecurityAuditLog = require("../models/SecurityAuditLog");
        SecurityAuditLog.create({
          event,
          ip: payload.ip,
          path: payload.path,
          userId: payload.userId,
          tenantId: payload.tenantId || payload.clientId,
          targetClientId: payload.targetClientId,
          reason: payload.reason,
          meta: payload,
        }).catch(() => {});
      } catch (_) {
        /* model optional */
      }
    });
  }
}

module.exports = { auditSecurity, redact };
