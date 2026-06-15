'use strict';

const assert = require('assert');
const {
  matchTopPerformanceRoute,
  TOP_ROUTE_PATTERNS,
} = require('../../middleware/sentryPerformanceMiddleware');

assert.ok(TOP_ROUTE_PATTERNS.length >= 10, 'expected at least 10 top route patterns');

const cases = [
  ['/api/auth/bootstrap', 'auth.bootstrap'],
  ['/api/workspace/client_abc/shell', 'workspace.shell'],
  ['/api/workspace/client_abc/connection-status', 'workspace.connection-status'],
  ['/api/dashboard/workspace?days=30', 'dashboard.workspace'],
  ['/api/dashboard/summary', 'dashboard.summary'],
  ['/api/analytics/workspace', 'analytics.workspace'],
  ['/api/analytics/overview-bundle', 'analytics.overview-bundle'],
  ['/api/conversations/lead_1/full-context', 'conversations.full-context'],
  ['/api/conversations', 'conversations.list'],
  ['/api/templates/list', 'templates.list'],
  ['/api/health', null],
  ['/api/billing/plan', null],
];

for (const [path, expected] of cases) {
  const got = matchTopPerformanceRoute(path);
  assert.strictEqual(
    got,
    expected,
    `matchTopPerformanceRoute(${JSON.stringify(path)}) expected ${expected}, got ${got}`
  );
}

const mw = require('../../middleware/sentryPerformanceMiddleware');
assert.equal(typeof mw, 'function');

console.log('✓ sentryTopRoutes.test.js passed');
