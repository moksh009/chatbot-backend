'use strict';

const { requireRole, requireRoleCategory } = require('./requireRole');
const { isPublicApiPath } = require('./publicRoute');

const INBOX_PATH_RE =
  /^\/api\/conversations\/[^/]+\/(messages|takeover|release|assign|upload-media|send-template|resend-checkout)/i;

function roleForMethod() {
  return (req, res, next) => {
    if (req.isPublicRoute || isPublicApiPath(req.originalUrl)) return next();
    if (!req.user) return next();
    if (req.user.role === 'SUPER_ADMIN') return next();

    const path = req.originalUrl || req.path || '';
    const method = req.method.toUpperCase();

    if (path.startsWith('/api/admin')) return next();
    if (path.startsWith('/api/auth')) return next();

    if (path.startsWith('/api/team') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return requireRoleCategory('team')(req, res, next);
    }
    if (path.startsWith('/api/billing') && method !== 'GET') {
      return requireRoleCategory('billing')(req, res, next);
    }

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      if (INBOX_PATH_RE.test(path)) {
        return requireRoleCategory('inbox_send')(req, res, next);
      }
      return requireRoleCategory('mutate_config')(req, res, next);
    }

    return requireRoleCategory('read')(req, res, next);
  };
}

module.exports = { roleForMethod };
