'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePublicOrigin,
  getGoogleAuthRedirectUri,
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
