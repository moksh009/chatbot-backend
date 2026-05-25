'use strict';

const { auditLog } = require('../../services/audit/auditWriter');
const { sendSystemOTPEmail } = require('../core/emailService');

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 30 * 60 * 1000;

function isLocked(user) {
  return user.lockedUntil && new Date(user.lockedUntil) > new Date();
}

function recordFailedAttempt(user) {
  const now = Date.now();
  const fla = user.failedLoginAttempts || { count: 0, firstAttemptAt: null };
  if (!fla.firstAttemptAt || now - new Date(fla.firstAttemptAt).getTime() > WINDOW_MS) {
    fla.count = 1;
    fla.firstAttemptAt = new Date();
  } else {
    fla.count += 1;
  }
  user.failedLoginAttempts = fla;
  if (fla.count >= MAX_ATTEMPTS) {
    user.lockedUntil = new Date(now + LOCKOUT_MS);
    auditLog({
      category: 'auth',
      action: 'account_locked',
      severity: 'high',
      clientId: user.clientId,
      actor: { type: 'user', userId: user._id, source: 'auth' },
      details: { email: user.email, attempts: fla.count },
      blocking: true,
    });
    sendSystemOTPEmail(
      user.email,
      'Account temporarily locked',
      'Your account was locked after multiple failed login attempts. Try again in 30 minutes or reset your password.'
    ).catch(() => {});
  }
  return user;
}

function clearFailedAttempts(user) {
  user.failedLoginAttempts = { count: 0, firstAttemptAt: null };
  user.lockedUntil = null;
  return user;
}

module.exports = {
  isLocked,
  recordFailedAttempt,
  clearFailedAttempts,
  MAX_ATTEMPTS,
  LOCKOUT_MS,
};
