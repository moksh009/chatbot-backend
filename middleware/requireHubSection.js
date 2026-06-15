'use strict';

const { hubSectionAllowed } = require('../constants/hubSections');

/**
 * Deny AGENT users when their hubAccess does not include sectionId.
 * CLIENT_ADMIN / SUPER_ADMIN bypass.
 */
function requireHubSection(sectionId) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (hubSectionAllowed(req.user, sectionId)) return next();
    return res.status(403).json({
      success: false,
      code: 'HUB_SECTION_FORBIDDEN',
      message: 'You do not have permission to manage this section.',
    });
  };
}

module.exports = { requireHubSection };
