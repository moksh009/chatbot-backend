'use strict';

const User = require('../models/User');
const { hasMasterTesterBypass } = require('./productionSecurity');

function blockMasterTesterOnAdmin(req, res, next) {
  if (hasMasterTesterBypass(req.user)) {
    return res.status(403).json({ message: 'Master tester bypass is not allowed on admin routes' });
  }
  return next();
}

async function requireAdminUser(req, res, next) {
  try {
    if (req.user?.isAdminTeam) return next();
    const user = await User.findById(req.user?._id || req.user?.id).select('role').lean();
    if (user?.role === 'SUPER_ADMIN') return next();
    return res.status(403).json({ message: 'Access denied: Admin only' });
  } catch (error) {
    return res.status(500).json({ message: 'Server error' });
  }
}

function getAllowedClientIds(req) {
  if (req.user?.role === 'SUPER_ADMIN') return null;
  if (req.user?.isAdminTeam) {
    const ids = req.user.allowedClientIds || [];
    return ids.length ? ids : null;
  }
  return [];
}

function applyClientScopeFilter(baseFilter, req) {
  const allowed = getAllowedClientIds(req);
  if (!allowed?.length) return baseFilter;
  return { ...baseFilter, clientId: { $in: allowed } };
}

/** SUPER_ADMIN User or AdminTeamMember with optional permission key. */
function authorizeAdminScope(permissionKey) {
  return (req, res, next) => {
    if (req.user?.role === 'SUPER_ADMIN') return next();
    if (req.user?.isAdminTeam) {
      const perms = req.user.permissions || {};
      if (perms.manageTeam) return next();
      if (permissionKey && perms[permissionKey]) return next();
    }
    return res.status(403).json({ message: 'Forbidden' });
  };
}

module.exports = {
  blockMasterTesterOnAdmin,
  requireAdminUser,
  getAllowedClientIds,
  applyClientScopeFilter,
  authorizeAdminScope,
};
