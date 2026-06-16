const mongoose = require("mongoose");
const Client   = require("../../models/Client");
const logger   = require('./logger')("QueryHelpers");
const { hasMasterTesterBypass } = require("../../middleware/productionSecurity");
const { auditSecurity } = require("../../middleware/securityAudit");
const {
  canImpersonateMerchants,
  isImpersonationAllowedForClient,
} = require("../../middleware/adminAccess");

function resolveImpersonatedClientId(req) {
  const raw = req.headers["x-admin-impersonating"];
  if (!raw) return null;
  const target = String(raw).trim();
  if (!target) return null;
  const gate = isImpersonationAllowedForClient(req.user, target);
  return gate.ok ? target : null;
}

/**
 * Tenant isolation: non–super-admins MUST only ever use `req.user.clientId`.
 * Super-admins and authorized admin-team members may impersonate via header.
 */
function tenantClientId(req) {
  if (!req.user) return null;

  if (req.user.role === "SUPER_ADMIN") {
    const impersonating = resolveImpersonatedClientId(req);
    if (impersonating) return impersonating;
    return (
      req.params?.clientId ||
      req.query?.clientId ||
      req.body?.clientId ||
      req.user.clientId ||
      null
    );
  }

  if (canImpersonateMerchants(req.user)) {
    const impersonating = resolveImpersonatedClientId(req);
    if (impersonating) return impersonating;
    const fromParams =
      req.params?.clientId || req.query?.clientId || req.body?.clientId;
    if (fromParams) {
      const target = String(fromParams).trim();
      const gate = isImpersonationAllowedForClient(req.user, target);
      if (gate.ok) return target;
    }
    return null;
  }

  return req.user.clientId || null;
}

/**
 * Ensure the authenticated user may access `targetClientId`.
 * Regular users are locked to JWT `clientId`; super-admins may impersonate via params/query/body.
 */
function assertTenantAccess(req, targetClientId) {
  const target = targetClientId != null ? String(targetClientId).trim() : "";
  if (!target) {
    return {
      ok: false,
      status: 403,
      message: "Unauthorized access to this workspace",
    };
  }

  if (hasMasterTesterBypass(req.user)) {
    return { ok: true, tenantId: target };
  }

  const tenantId = tenantClientId(req);
  if (!tenantId || tenantId !== target) {
    return {
      ok: false,
      status: 403,
      message: "Unauthorized access to this workspace",
    };
  }
  return { ok: true, tenantId };
}

/** Send 403 and return false when access is denied; otherwise return tenantId string. */
function denyUnlessTenant(req, res, targetClientId) {
  const gate = assertTenantAccess(req, targetClientId);
  if (!gate.ok) {
    auditSecurity("TENANT_ACCESS_DENIED", {
      req,
      userId: req.user?._id,
      userEmail: req.user?.email,
      tenantId: req.user?.clientId,
      targetClientId,
      reason: gate.message,
    });
    res.status(gate.status).json({ success: false, message: gate.message });
    return null;
  }
  return gate.tenantId;
}

/**
 * Resolve a clientId (string slug OR ObjectId string) to a Client document.
 * Returns { client, clientOid } or throws an error.
 *
 * Uses tenantClientId — regular users cannot escalate via query/params.
 */
async function resolveClient(req) {
  const rawId = tenantClientId(req);

  if (!rawId) throw new Error("No clientId provided");
  
  // Try to find by slug first (most common case)
  let client = await Client.findOne({ clientId: rawId }).lean();
  
  // If not found by slug, try by MongoDB _id
  if (!client && mongoose.Types.ObjectId.isValid(rawId)) {
    client = await Client.findById(rawId).lean();
  }
  
  if (!client) throw new Error(`Client not found: ${rawId}`);
  
  const clientOid = client._id; // This is always a proper ObjectId
  
  return { client, clientOid };
}

/** Same as resolveClient but returns { client: null } instead of throwing when tenant is missing. */
async function resolveClientOrNull(req) {
  try {
    return await resolveClient(req);
  } catch {
    return { client: null, clientOid: null };
  }
}

/**
 * Get start of day in IST as UTC Date.
 * Use this instead of new Date().setHours(0,0,0,0)
 */
function startOfDayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 5.5 * 60 * 60 * 1000);
}

/** YYYY-MM-DD in Asia/Kolkata (UTC+5:30). */
function formatDateStrIST(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayDateStrIST() {
  return formatDateStrIST(new Date());
}

function istDateOffsetDays(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  const shifted = new Date(utcMidnight + deltaDays * 86400000);
  return formatDateStrIST(new Date(shifted.getTime() - 5.5 * 60 * 60 * 1000));
}

function startOfDayForDateStrIST(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
}

function endOfDayForDateStrIST(dateStr) {
  return new Date(startOfDayForDateStrIST(dateStr).getTime() + 86400000 - 1);
}

/** Inclusive IST date range for dashboard period KPIs (max 90 days). */
function istDateRangeStrings(days) {
  const n = Math.min(Math.max(parseInt(days, 10) || 1, 1), 90);
  const end = todayDateStrIST();
  const start = istDateOffsetDays(end, -(n - 1));
  return { start, end, days: n };
}

function startOfWeekIST() {
  const sod  = startOfDayIST();
  const day  = sod.getDay(); // 0=Sun
  const diff = sod.getTime() - day * 24 * 3600 * 1000;
  return new Date(diff);
}

function startOfMonthIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1, 0, 0, 0)
    - 5.5 * 60 * 60 * 1000);
}

/**
 * Safe aggregation wrapper — never throws, returns [] on error.
 */
async function safeAggregate(Model, pipeline) {
  try {
    return await Model.aggregate(pipeline);
  } catch (err) {
    logger.error(`[safeAggregate] ${Model.modelName} failed:`, err.message);
    return [];
  }
}

/**
 * Safe count — never throws, returns 0 on error.
 */
async function safeCount(Model, query) {
  try {
    return await Model.countDocuments(query);
  } catch (err) {
    logger.error(`[safeCount] ${Model.modelName} failed:`, err.message);
    return 0;
  }
}

/**
 * Safe findOne — never throws, returns null on error.
 */
async function safeFindOne(Model, query, select = null) {
  try {
    const q = Model.findOne(query);
    if (select) q.select(select);
    return await q.lean();
  } catch (err) {
    logger.error(`[safeFindOne] ${Model.modelName} failed:`, err.message);
    return null;
  }
}

module.exports = {
  tenantClientId,
  assertTenantAccess,
  denyUnlessTenant,
  resolveClient,
  resolveClientOrNull,
  startOfDayIST,
  startOfWeekIST,
  startOfMonthIST,
  formatDateStrIST,
  todayDateStrIST,
  istDateOffsetDays,
  startOfDayForDateStrIST,
  endOfDayForDateStrIST,
  istDateRangeStrings,
  safeAggregate,
  safeCount,
  safeFindOne
};
