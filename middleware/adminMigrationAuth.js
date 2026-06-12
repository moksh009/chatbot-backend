'use strict';

/** Require ADMIN_MIGRATION_SECRET via Authorization header or query key (legacy). */
function requireAdminMigrationSecret(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const queryKey = req.query.key || req.query.secret || '';
  const expected = process.env.ADMIN_MIGRATION_SECRET || process.env.ADMIN_MIGRATION_KEY;

  if (!expected) {
    return res.status(503).json({ message: 'Migration endpoints disabled — set ADMIN_MIGRATION_SECRET' });
  }

  if (bearer === expected || queryKey === expected) {
    return next();
  }

  return res.status(401).json({ message: 'Unauthorized migration request' });
}

module.exports = { requireAdminMigrationSecret };
