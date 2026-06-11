'use strict';

const SESSION_COOKIE = 'te_dash_sid';
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function resolveTelemetryCookieDomain() {
  const explicit = String(process.env.TELEMETRY_COOKIE_DOMAIN || '').trim();
  if (explicit) return explicit;
  if (!isProduction()) return undefined;
  return '.topedgeai.com';
}

function sessionCookieOptions() {
  const domain = resolveTelemetryCookieDomain();
  const prod = isProduction();
  const opts = {
    httpOnly: true,
    secure: prod,
    sameSite: prod ? 'none' : 'lax',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  };
  if (domain) opts.domain = domain;
  return opts;
}

function isValidSessionId(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value.trim());
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  sessionCookieOptions,
  resolveTelemetryCookieDomain,
  isValidSessionId,
};
