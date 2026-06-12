'use strict';

function requireAdminPermission(permissionKey) {
  return (req, res, next) => {
    if (req.user?.role === 'SUPER_ADMIN') return next();
    if (req.user?.adminRole === 'SUPER_ADMIN') return next();
    const perms = req.user?.permissions || {};
    if (perms[permissionKey] || perms.manageTeam) return next();
    return res.status(403).json({ message: `Missing permission: ${permissionKey}` });
  };
}

module.exports = { requireAdminPermission };
