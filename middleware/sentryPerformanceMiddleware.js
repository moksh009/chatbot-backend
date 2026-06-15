'use strict';

/**
 * Sentry performance transactions for top cold-start / hub routes (Phase 5.2).
 * No-op when SENTRY_DSN is unset. Uses startSpanManual so span covers full request.
 */

/** Top 10 merchant-facing routes from SYSTEM-MASTER-AUDIT Part 6. */
const TOP_ROUTE_PATTERNS = [
  { test: /\/api\/auth\/bootstrap$/i, name: 'auth.bootstrap' },
  { test: /\/api\/workspace\/[^/]+\/shell$/i, name: 'workspace.shell' },
  { test: /\/api\/workspace\/[^/]+\/connection-status$/i, name: 'workspace.connection-status' },
  { test: /\/api\/dashboard\/workspace$/i, name: 'dashboard.workspace' },
  { test: /\/api\/dashboard\/summary$/i, name: 'dashboard.summary' },
  { test: /\/api\/analytics\/workspace$/i, name: 'analytics.workspace' },
  { test: /\/api\/analytics\/overview-bundle$/i, name: 'analytics.overview-bundle' },
  { test: /\/api\/conversations\/[^/]+\/full-context$/i, name: 'conversations.full-context' },
  { test: /^\/api\/conversations\/?$/i, name: 'conversations.list' },
  { test: /\/api\/templates\/list$/i, name: 'templates.list' },
];

function matchTopPerformanceRoute(pathname) {
  const clean = String(pathname || '').split('?')[0];
  for (const row of TOP_ROUTE_PATTERNS) {
    if (row.test.test(clean)) return row.name;
  }
  return null;
}

function sentryPerformanceMiddleware(req, res, next) {
  if (!process.env.SENTRY_DSN) return next();

  const routeName = matchTopPerformanceRoute(req.originalUrl || req.url);
  if (!routeName) return next();

  let Sentry;
  try {
    Sentry = require('@sentry/node');
  } catch {
    return next();
  }

  let ended = false;
  const finish = (statusCode) => {
    if (ended) return;
    ended = true;
    if (statusCode != null) {
      span.setAttribute('http.status_code', statusCode);
    }
    span.end();
  };

  let span;
  return Sentry.startSpanManual(
    {
      name: routeName,
      op: 'http.server',
      forceTransaction: true,
      attributes: {
        'http.method': req.method,
        'http.route': routeName,
      },
    },
    (activeSpan) => {
      span = activeSpan;
      res.once('finish', () => finish(res.statusCode));
      res.once('close', () => {
        if (!res.writableEnded) finish(res.statusCode || 499);
      });
      next();
    }
  );
}

module.exports = sentryPerformanceMiddleware;
module.exports.matchTopPerformanceRoute = matchTopPerformanceRoute;
module.exports.TOP_ROUTE_PATTERNS = TOP_ROUTE_PATTERNS;
