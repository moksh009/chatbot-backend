'use strict';

const { verifyTenantScope } = require('./verifyTenantScope');
const { isPublicApiPath } = require('./publicRoute');

/** Path segment → resource lookup key for :id / :leadId / etc. */
const PATH_RESOURCE_RULES = [
  { pattern: /^\/api\/campaigns\/[^/]+/i, lookupBy: 'campaign', param: 'id' },
  { pattern: /^\/api\/leads\/[^/]+/i, lookupBy: 'lead', param: 'id' },
  { pattern: /^\/api\/conversations\/[^/]+/i, lookupBy: 'conversation', param: 'id' },
  { pattern: /^\/api\/orders\/[^/]+/i, lookupBy: 'order', param: 'id' },
  { pattern: /^\/api\/sequences\/[^/]+\/[^/]+/i, lookupBy: 'sequence', param: 'sequenceId' },
  { pattern: /^\/api\/segments\/[^/]+/i, lookupBy: 'segment', param: 'id' },
  { pattern: /^\/api\/templates\/[^/]+/i, lookupBy: 'template', param: 'id' },
  { pattern: /^\/api\/meta-templates\/[^/]+/i, lookupBy: 'template', param: 'id' },
  { pattern: /^\/api\/knowledge\/[^/]+/i, lookupBy: 'knowledge', param: 'id' },
  { pattern: /^\/api\/training\/[^/]+/i, lookupBy: 'trainingCase', param: 'id' },
];

function inferScopeOpts(req) {
  const path = req.originalUrl || req.baseUrl + req.path || req.path || '';
  for (const rule of PATH_RESOURCE_RULES) {
    if (rule.pattern.test(path)) {
      return { lookupBy: rule.lookupBy, param: rule.param };
    }
  }
  if (req.params?.clientId) return {};
  if (req.params?.id && path.includes('/campaigns/')) return { lookupBy: 'campaign', param: 'id' };
  if (req.params?.id && path.includes('/leads/')) return { lookupBy: 'lead', param: 'id' };
  if (req.params?.leadId) return { lookupBy: 'lead', param: 'leadId' };
  if (req.params?.contactId) return { lookupBy: 'lead', param: 'contactId' };
  return {};
}

function autoTenantScope() {
  const scopeCache = new Map();
  return async (req, res, next) => {
    if (req.isPublicRoute || isPublicApiPath(req.originalUrl)) return next();
    if (!req.user) return next();
    const key = JSON.stringify(inferScopeOpts(req));
    if (!scopeCache.has(key)) scopeCache.set(key, verifyTenantScope(JSON.parse(key)));
    return scopeCache.get(key)(req, res, next);
  };
}

module.exports = { autoTenantScope, inferScopeOpts, PATH_RESOURCE_RULES };
