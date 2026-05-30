const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { assertTenantAccess, tenantClientId } = require('../utils/core/queryHelpers');
const { hasMasterTesterBypass } = require('./productionSecurity');
const { auditSecurity } = require('./securityAudit');

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    try {
      token = req.headers.authorization.split(' ')[1];
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        console.error('[Auth Middleware] FATAL: JWT_SECRET environment variable is not set');
        return res.status(500).json({ message: 'Server configuration error' });
      }
      const decoded = jwt.verify(token, jwtSecret);

      req.user = await User.findById(decoded.id).select('-password').maxTimeMS(8000);
      if (!req.user) {
          return res.status(401).json({ message: 'Not authorized, user not found' });
      }

      // Objective 1: Attach God Mode status
      const { getCachedClient } = require('../utils/core/clientCache');
      const client = await getCachedClient(req.user.clientId, 'isLifetimeAdmin');
      req.user.isLifetimeAdmin = req.user.role === 'SUPER_ADMIN' || (client && client.isLifetimeAdmin);

      if (req.user.clientId) {
        const { getCachedClientForWhatsAppSend } = require('../utils/core/clientCache');
        setImmediate(() => {
          getCachedClientForWhatsAppSend(req.user.clientId).catch(() => {});
        });
      }

      if (req.user.role !== 'SUPER_ADMIN') {
        const tenantId = req.user.clientId;
        for (const supplied of [req.body?.clientId, req.query?.clientId]) {
          if (supplied && String(supplied).trim() && String(supplied).trim() !== String(tenantId)) {
            auditSecurity('TENANT_BODY_SPOOF_BLOCKED', {
              req,
              tenantId,
              targetClientId: supplied,
              reason: 'clientId in body/query does not match session',
            });
            return res.status(403).json({
              success: false,
              message: 'Cannot access another workspace from this account',
            });
          }
        }
      }

      const { autoTenantScope } = require('./autoTenantScope');
      const { roleForMethod } = require('./roleForMethod');
      return autoTenantScope()(req, res, () => roleForMethod()(req, res, next));
    } catch (error) {
      console.error('[Auth Middleware] Error validating token or fetching user:', error);
      
      // If it's a genuine JWT error (expired, malformed, signature mismatch), it's a 401
      if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
        auditSecurity('AUTH_TOKEN_INVALID', { req, reason: error.name });
        return res.status(401).json({ message: 'Not authorized, token failed' });
      }

      // If it's a MongoDB timeout or other server-side issue during cold start, return 500
      // so the frontend knows it's a transient server issue and can retry, rather than logging out.
      return res.status(500).json({ message: 'Server Error during authentication', error: error.message });
    }
  }

  if (!token) {
    auditSecurity('AUTH_NO_TOKEN', { req });
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
};

/** After protect — blocks IDOR when route includes :clientId */
const requireTenantMatch = (req, res, next) => {
  const clientId = req.params?.clientId;
  if (!clientId || !req.user) return next();

  const gate = assertTenantAccess(req, clientId);
  if (!gate.ok) {
    auditSecurity('TENANT_ACCESS_DENIED', {
      req,
      userId: req.user._id,
      userEmail: req.user.email,
      tenantId: req.user.clientId,
      targetClientId: clientId,
      reason: gate.message,
    });
    return res.status(gate.status).json({ success: false, message: gate.message });
  }
  req.tenantId = gate.tenantId;
  next();
};

const authorize = (...roles) => {
  return (req, res, next) => {
    if (hasMasterTesterBypass(req.user)) {
      return next();
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: `User role ${req.user.role} is not authorized to access this route`
      });
    }
    next();
  };
};

const verifyClientAccess = (req, res, next) => requireTenantMatch(req, res, next);

module.exports = {
  protect,
  verifyToken: protect,
  authorize,
  verifyClientAccess,
  requireTenantMatch,
};
