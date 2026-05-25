'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { tenantRateLimit } = require('./tenantRateLimit');
const { requirePaidOrTrial } = require('./requirePaidOrTrial');

/**
 * Lightweight JWT attach for global /api rate limit + plan gate (no 401 without token).
 */
async function attachUserIfPresent(req, res, next) {
  if (req.user) return next();
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();
  const token = header.split(' ')[1];
  const secret = process.env.JWT_SECRET;
  if (!secret) return next();
  try {
    const decoded = jwt.verify(token, secret);
    req.user = await User.findById(decoded.id).select('-password').lean();
  } catch (_) {
    /* invalid token — route-level protect will 401 */
  }
  return next();
}

const apiSecurityLayer = [attachUserIfPresent, tenantRateLimit(), requirePaidOrTrial()];

module.exports = { attachUserIfPresent, apiSecurityLayer };
