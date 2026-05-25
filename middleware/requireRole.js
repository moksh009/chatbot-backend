'use strict';

const ROLE_MATRIX = {
  read: ['CLIENT_ADMIN', 'AGENT', 'RECEPTIONIST', 'VIEWER', 'SUPER_ADMIN'],
  inbox_send: ['CLIENT_ADMIN', 'AGENT', 'SUPER_ADMIN'],
  mutate_config: ['CLIENT_ADMIN', 'SUPER_ADMIN'],
  team: ['CLIENT_ADMIN', 'SUPER_ADMIN'],
  billing: ['CLIENT_ADMIN', 'SUPER_ADMIN'],
  super_admin: ['SUPER_ADMIN'],
};

function requireRole(...roles) {
  const allowed = roles.length ? roles : ROLE_MATRIX.read;
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({
        error: 'forbidden',
        message: `Role ${req.user.role} is not authorized`,
      });
    }
    return next();
  };
}

function requireRoleCategory(category) {
  return requireRole(...(ROLE_MATRIX[category] || ROLE_MATRIX.read));
}

module.exports = { requireRole, requireRoleCategory, ROLE_MATRIX };
