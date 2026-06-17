'use strict';

/**
 * Google login OAuth redirect URI (NOT calendar — that is /api/oauth/google/callback).
 * Must exactly match an entry under Google Cloud Console → Credentials → OAuth client →
 * Authorized redirect URIs for the same client as GOOGLE_CLIENT_ID.
 */

const LOGIN_CALLBACK_PATH = '/api/auth/google/callback';
const CALENDAR_CALLBACK_PATH = '/api/oauth/google/callback';

/** Strip trailing slashes and a trailing /api segment from a public origin. */
function normalizePublicOrigin(raw) {
  let base = String(raw || '').trim().replace(/\s+/g, '');
  if (!base) return '';
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/api$/i, '');
  return base;
}

function resolvePublicBackendOrigin() {
  const explicitRedirect = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  if (explicitRedirect) {
    try {
      const u = new URL(explicitRedirect.replace(/\s+/g, ''));
      return `${u.protocol}//${u.host}`;
    } catch {
      /* fall through */
    }
  }

  const candidates = [
    process.env.GOOGLE_OAUTH_BACKEND_URL,
    process.env.SERVER_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.BACKEND_URL,
    process.env.RENDER_EXTERNAL_URL,
    process.env.API_BASE,
  ];

  for (const c of candidates) {
    const base = normalizePublicOrigin(c);
    if (base) {
      if (!/^https:\/\//i.test(base)) {
        return `https://${base.replace(/^https?:\/\//i, '')}`;
      }
      return base;
    }
  }

  return 'https://api.topedgeai.com';
}

function getGoogleAuthRedirectUri() {
  const explicit = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();
  if (explicit) return explicit.replace(/\s+/g, '');
  const base = resolvePublicBackendOrigin();
  return `${base}${LOGIN_CALLBACK_PATH}`;
}

/** Gmail / calendar OAuth callback used by Settings + Email Hub connect. */
function getGmailOAuthRedirectUri() {
  const explicit = String(process.env.GMAIL_OAUTH_REDIRECT_URI || '').trim();
  if (explicit) return explicit.replace(/\s+/g, '');
  const base = resolvePublicBackendOrigin();
  return `${base}${CALENDAR_CALLBACK_PATH}`;
}

/** URIs to register in Google Cloud (login + calendar + common legacy hosts). */
function getGoogleOAuthRedirectUriChecklist() {
  const primary = getGoogleAuthRedirectUri();
  const gmail = getGmailOAuthRedirectUri();
  const origin = resolvePublicBackendOrigin();
  const set = new Set([primary, gmail, `${origin}${CALENDAR_CALLBACK_PATH}`]);

  const legacyHosts = [
    'https://api.topedgeai.com',
    'https://chatbot-backend-lg5y.onrender.com',
  ];
  for (const host of legacyHosts) {
    set.add(`${host}${LOGIN_CALLBACK_PATH}`);
    set.add(`${host}${CALENDAR_CALLBACK_PATH}`);
  }

  if (process.env.NODE_ENV !== 'production') {
    const port = process.env.PORT || 5001;
    set.add(`http://localhost:${port}${LOGIN_CALLBACK_PATH}`);
    set.add(`http://localhost:${port}${CALENDAR_CALLBACK_PATH}`);
  }

  return [...set].sort();
}

function getGoogleOAuthPublicConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const redirectUri = getGoogleAuthRedirectUri();
  const gmailRedirectUri = getGmailOAuthRedirectUri();
  const health = getGoogleOAuthConfigHealth();
  const configured = Boolean(clientId && process.env.GOOGLE_CLIENT_SECRET);
  return {
    configured,
    health,
    redirectUri,
    gmailRedirectUri,
    clientIdSuffix: clientId ? clientId.slice(-20) : null,
    backendOrigin: resolvePublicBackendOrigin(),
    registerTheseRedirectUris: getGoogleOAuthRedirectUriChecklist(),
    consoleUrl:
      'https://console.cloud.google.com/apis/credentials',
    docsPath: 'docs/ops/GOOGLE_OAUTH_SETUP.md',
  };
}

function getGoogleOAuthConfigHealth() {
  const issues = [];
  const warnings = [];
  const isProd = process.env.NODE_ENV === 'production';
  const redirectUri = getGoogleAuthRedirectUri();
  const explicitRedirect = String(process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim();

  if (!String(process.env.GOOGLE_CLIENT_ID || '').trim()) {
    issues.push('GOOGLE_CLIENT_ID is missing');
  }
  if (!String(process.env.GOOGLE_CLIENT_SECRET || '').trim()) {
    issues.push('GOOGLE_CLIENT_SECRET is missing');
  }

  let parsed = null;
  try {
    parsed = new URL(redirectUri);
  } catch (_) {
    issues.push('GOOGLE_OAUTH_REDIRECT_URI is invalid URL');
  }

  if (parsed) {
    if (isProd && parsed.protocol !== 'https:') {
      issues.push('Google login redirect URI must be https in production');
    }
    if (parsed.pathname !== LOGIN_CALLBACK_PATH) {
      issues.push(`Google login redirect URI path must be ${LOGIN_CALLBACK_PATH}`);
    }
  }

  if (isProd && !explicitRedirect) {
    warnings.push(
      'GOOGLE_OAUTH_REDIRECT_URI is not explicitly set; inferred fallback can drift from Google Console config'
    );
  }

  if (!String(process.env.FRONTEND_URL || '').trim()) {
    warnings.push('FRONTEND_URL is not set; OAuth callback fallback URL will be used');
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
  };
}

module.exports = {
  LOGIN_CALLBACK_PATH,
  CALENDAR_CALLBACK_PATH,
  normalizePublicOrigin,
  resolvePublicBackendOrigin,
  getGoogleAuthRedirectUri,
  getGmailOAuthRedirectUri,
  getGoogleOAuthRedirectUriChecklist,
  getGoogleOAuthConfigHealth,
  getGoogleOAuthPublicConfig,
};
