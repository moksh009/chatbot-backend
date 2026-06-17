'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePublicOrigin,
  getGoogleAuthRedirectUri,
  getGoogleOAuthConfigHealth,
} = require('../../utils/auth/googleOAuthConfig');

const envSnapshot = { ...process.env };

test.afterEach(() => {
  process.env = { ...envSnapshot };
});

test('strips trailing /api from origin env vars', () => {
  assert.equal(
    normalizePublicOrigin('https://api.topedgeai.com/api'),
    'https://api.topedgeai.com'
  );
});

test('uses GOOGLE_OAUTH_REDIRECT_URI when set', () => {
  process.env.GOOGLE_OAUTH_REDIRECT_URI =
    'https://api.topedgeai.com/api/auth/google/callback';
  delete process.env.SERVER_URL;
  assert.equal(
    getGoogleAuthRedirectUri(),
    'https://api.topedgeai.com/api/auth/google/callback'
  );
});

test('builds callback from SERVER_URL', () => {
  delete process.env.GOOGLE_OAUTH_REDIRECT_URI;
  process.env.SERVER_URL = 'https://api.topedgeai.com';
  assert.equal(
    getGoogleAuthRedirectUri(),
    'https://api.topedgeai.com/api/auth/google/callback'
  );
});

test('health fails in production when redirect uri path is wrong', () => {
  process.env.NODE_ENV = 'production';
  process.env.GOOGLE_CLIENT_ID = 'id';
  process.env.GOOGLE_CLIENT_SECRET = 'secret';
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://api.topedgeai.com/api/oauth/google/callback';
  const health = getGoogleOAuthConfigHealth();
  assert.equal(health.ok, false);
  assert.ok(
    health.issues.some((issue) => issue.includes('/api/auth/google/callback'))
  );
});
