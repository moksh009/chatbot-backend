'use strict';

const crypto = require('crypto');
const ClientTelemetryEvent = require('../../models/ClientTelemetryEvent');
const { TELEMETRY_KINDS } = require('../../models/ClientTelemetryEvent');

const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
  /(token|password|secret|api[_-]?key)\s*[:=]\s*["']?[^"'\s,}]+/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  /\b(?:\+?91|0)?[6-9]\d{9}\b/g,
];

function scrubText(input = '') {
  let out = String(input || '').slice(0, 8000);
  for (const re of SENSITIVE_PATTERNS) {
    out = out.replace(re, '[redacted]');
  }
  return out;
}

function eventFingerprint(payload = {}) {
  const metaKey =
    payload.metadata?.action ||
    payload.metadata?.tab ||
    payload.metadata?.step ||
    '';
  const base = [
    payload.kind,
    payload.clientId,
    payload.feature || '',
    payload.route || '',
    payload.apiPath || '',
    payload.httpStatus || '',
    metaKey,
    scrubText(payload.message || '').slice(0, 200),
  ].join('|');
  return crypto.createHash('sha256').update(base).digest('hex').slice(0, 24);
}

function parseBrowser(userAgent = '') {
  const ua = String(userAgent);
  if (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS/i.test(ua)) return 'safari';
  if (/Chrome|Chromium|CriOS/i.test(ua)) return 'chrome';
  if (/Firefox/i.test(ua)) return 'firefox';
  if (/Edg/i.test(ua)) return 'edge';
  return 'other';
}

function captureToSentry(err, context = {}) {
  if (!process.env.SENTRY_DSN) return;
  try {
    const Sentry = require('@sentry/node');
    Sentry.withScope((scope) => {
      if (context.clientId) scope.setTag('clientId', context.clientId);
      if (context.userId) scope.setUser({ id: String(context.userId) });
      if (context.feature) scope.setTag('feature', context.feature);
      if (context.route) scope.setTag('route', context.route);
      if (context.kind) scope.setTag('telemetryKind', context.kind);
      Sentry.captureException(err);
    });
  } catch {
    /* non-fatal */
  }
}

async function persistEvent(raw = {}) {
  const message = scrubText(raw.message);
  const stack = scrubText(raw.stack);
  const fingerprint = eventFingerprint({ ...raw, message });

  const doc = {
    clientId: raw.clientId,
    userId: raw.userId || undefined,
    sessionId: raw.sessionId || undefined,
    kind: raw.kind,
    feature: raw.feature ? String(raw.feature).slice(0, 80) : undefined,
    route: raw.route ? String(raw.route).slice(0, 300) : undefined,
    message: message ? message.slice(0, 2000) : undefined,
    stack: stack ? stack.slice(0, 6000) : undefined,
    httpStatus: raw.httpStatus,
    httpMethod: raw.httpMethod,
    apiPath: raw.apiPath ? String(raw.apiPath).slice(0, 300) : undefined,
    userAgent: raw.userAgent ? String(raw.userAgent).slice(0, 400) : undefined,
    browser: parseBrowser(raw.userAgent),
    metadata: raw.metadata,
    fingerprint,
  };

  const dedupeWindowMs =
    raw.kind === 'page_view' || raw.kind === 'hub_tab_view' ? 30 * 1000 : 5 * 60 * 1000;

  const recentDup = await ClientTelemetryEvent.findOne({
    fingerprint,
    clientId: raw.clientId,
    createdAt: { $gte: new Date(Date.now() - dedupeWindowMs) },
  })
    .select('_id')
    .lean();

  if (recentDup) {
    return { inserted: false, duplicate: true, fingerprint };
  }

  await ClientTelemetryEvent.create(doc);
  return { inserted: true, fingerprint };
}

async function ingestClientEvents(user, events = [], req = {}) {
  if (!user?.clientId) {
    throw new Error('Missing tenant context');
  }
  const sessionId = req.teSessionId || req.body?.sessionId;
  const userAgent = req.headers['user-agent'];
  const accepted = [];
  const skipped = [];

  for (const ev of events.slice(0, 20)) {
    const kind = ev?.kind;
    if (!TELEMETRY_KINDS.includes(kind)) {
      skipped.push({ kind, reason: 'invalid_kind' });
      continue;
    }

    if (['page_view', 'feature_click', 'hub_tab_view', 'funnel_step'].includes(kind)) {
      skipped.push({ kind, reason: 'analytics_requires_consent' });
      continue;
    }

    try {
      const result = await persistEvent({
        clientId: user.clientId,
        userId: user._id,
        sessionId,
        kind,
        feature: ev.feature,
        route: ev.route,
        message: ev.message,
        stack: ev.stack,
        httpStatus: ev.httpStatus,
        httpMethod: ev.httpMethod,
        apiPath: ev.apiPath,
        userAgent,
        metadata: ev.metadata,
      });
      accepted.push({ kind, ...result });
    } catch (e) {
      skipped.push({ kind, reason: e.message });
    }
  }

  return { accepted, skipped };
}

async function ingestAnalyticsEvents(user, events = [], req = {}) {
  if (!user?.clientId) throw new Error('Missing tenant context');
  const sessionId = req.teSessionId || req.body?.sessionId;
  const userAgent = req.headers['user-agent'];
  const accepted = [];

  for (const ev of events.slice(0, 20)) {
    const kind = ev?.kind;
    if (!['page_view', 'feature_click', 'hub_tab_view', 'funnel_step'].includes(kind)) continue;
    const result = await persistEvent({
      clientId: user.clientId,
      userId: user._id,
      sessionId,
      kind,
      feature: ev.feature,
      route: ev.route,
      message: ev.message,
      userAgent,
      metadata: ev.metadata,
    });
    accepted.push({ kind, ...result });
  }

  return { accepted };
}

async function resolveFunnelState(clientId) {
  const Client = require('../../models/Client');
  const MetaTemplate = require('../../models/MetaTemplate');
  const Campaign = require('../../models/Campaign');
  const { ONBOARDING_FUNNEL_STEPS } = require('../../constants/productAnalytics');

  const client = await Client.findOne({ clientId }).lean();
  if (!client) {
    return ONBOARDING_FUNNEL_STEPS.map((s) => ({
      id: s.id,
      label: s.label,
      completed: s.id === 'account_created',
    }));
  }

  const shopifyOk =
    !!(client.shopifyDomain && String(client.shopifyDomain).includes('.')) &&
    !!(client.shopifyAccessToken || client.shopifyRefreshToken);
  const whatsappOk =
    !!client.whatsappConnectedAt ||
    !!(client.phoneNumberId && client.wabaId && client.whatsappToken);

  const [templateCount, campaignCount] = await Promise.all([
    MetaTemplate.countDocuments({ clientId }).maxTimeMS(5000).catch(() => 0),
    Campaign.countDocuments({ clientId }).maxTimeMS(5000).catch(() => 0),
  ]);

  const flags = {
    account: true,
    shopify: shopifyOk,
    whatsapp: whatsappOk,
    template: templateCount > 0,
    campaign: campaignCount > 0,
  };

  return ONBOARDING_FUNNEL_STEPS.map((step) => ({
    id: step.id,
    label: step.label,
    completed: !!flags[step.serverKey],
  }));
}

async function getProductUsageSummary(clientId, { days = 7 } = {}) {
  const { FEATURE_LABELS, ONBOARDING_FUNNEL_STEPS, PRODUCT_ACTIONS } = require('../../constants/productAnalytics');
  const windowDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  const funnelSteps = await resolveFunnelState(clientId);
  const firstIncomplete = funnelSteps.find((s) => !s.completed);
  const dropOffStep = firstIncomplete
    ? { id: firstIncomplete.id, label: firstIncomplete.label }
    : null;

  const usageAgg = await ClientTelemetryEvent.aggregate([
    {
      $match: {
        clientId,
        createdAt: { $gte: since },
        kind: { $in: ['page_view', 'feature_click', 'hub_tab_view'] },
      },
    },
    {
      $group: {
        _id: { feature: '$feature', kind: '$kind' },
        count: { $sum: 1 },
      },
    },
  ]);

  const byFeature = {};
  for (const row of usageAgg) {
    const feature = row._id?.feature || 'dashboard';
    if (!byFeature[feature]) {
      byFeature[feature] = { feature, views: 0, clicks: 0, tabViews: 0 };
    }
    if (row._id.kind === 'page_view') byFeature[feature].views += row.count;
    if (row._id.kind === 'feature_click') byFeature[feature].clicks += row.count;
    if (row._id.kind === 'hub_tab_view') byFeature[feature].tabViews += row.count;
  }

  const topFeatures = Object.values(byFeature)
    .map((row) => ({
      feature: row.feature,
      label: FEATURE_LABELS[row.feature] || row.feature,
      views: row.views,
      clicks: row.clicks,
      tabViews: row.tabViews,
      score: row.views + row.tabViews * 2 + row.clicks * 3,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const actionAgg = await ClientTelemetryEvent.aggregate([
    {
      $match: {
        clientId,
        createdAt: { $gte: since },
        kind: 'feature_click',
        'metadata.action': { $exists: true },
      },
    },
    {
      $group: {
        _id: '$metadata.action',
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 5 },
  ]);

  const recentActions = actionAgg.map((row) => ({
    action: row._id,
    label: PRODUCT_ACTIONS[row._id] || row._id,
    count: row.count,
  }));

  const hasAnalyticsData = usageAgg.length > 0;

  return {
    days: windowDays,
    hasAnalyticsData,
    topFeatures,
    recentActions,
    funnel: {
      steps: funnelSteps,
      dropOffStep,
      completedCount: funnelSteps.filter((s) => s.completed).length,
      totalSteps: ONBOARDING_FUNNEL_STEPS.length,
    },
  };
}

async function recordServerError(req, err) {
  const clientId =
    req.user?.clientId ||
    req.clientConfig?.clientId ||
    req.params?.clientId ||
    req.body?.clientId ||
    'system';

  const payload = {
    clientId: String(clientId),
    userId: req.user?._id,
    kind: 'server_error',
    feature: req.telemetryFeature,
    route: req.originalUrl,
    message: err?.message,
    stack: err?.stack,
    httpMethod: req.method,
    apiPath: req.originalUrl,
    httpStatus: err.status || 500,
    userAgent: req.headers['user-agent'],
  };

  try {
    await persistEvent(payload);
  } catch {
    /* non-fatal */
  }

  captureToSentry(err, {
    clientId: payload.clientId,
    userId: payload.userId,
    feature: payload.feature,
    route: payload.route,
    kind: 'server_error',
  });
}

async function getClientHealthSummary({ hours = 24, limit = 50 } = {}) {
  const since = new Date(Date.now() - Math.min(Math.max(Number(hours) || 24, 1), 168) * 3600 * 1000);
  const match = {
    createdAt: { $gte: since },
    kind: { $in: ['error', 'api_failure', 'server_error'] },
  };

  const rows = await ClientTelemetryEvent.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$clientId',
        errorCount: { $sum: 1 },
        lastErrorAt: { $max: '$createdAt' },
        lastMessage: { $last: '$message' },
        topFeature: { $last: '$feature' },
        topRoute: { $last: '$route' },
        browsers: { $addToSet: '$browser' },
      },
    },
    { $sort: { errorCount: -1, lastErrorAt: -1 } },
    { $limit: Math.min(Number(limit) || 50, 200) },
  ]);

  const clientIds = rows.map((r) => r._id).filter(Boolean);
  const Client = require('../../models/Client');
  const clients = await Client.find({ clientId: { $in: clientIds } })
    .select('clientId businessName shopifyDomain whatsappConnectedAt')
    .lean();
  const clientMap = Object.fromEntries(clients.map((c) => [c.clientId, c]));

  return rows.map((row) => ({
    clientId: row._id,
    businessName: clientMap[row._id]?.businessName || row._id,
    shopifyDomain: clientMap[row._id]?.shopifyDomain || null,
    whatsappConnected: !!clientMap[row._id]?.whatsappConnectedAt,
    errorCount: row.errorCount,
    lastErrorAt: row.lastErrorAt,
    lastMessage: row.lastMessage,
    topFeature: row.topFeature,
    topRoute: row.topRoute,
    browsers: (row.browsers || []).filter(Boolean),
  }));
}

async function getClientTelemetryEvents(clientId, { limit = 50, hours = 72 } = {}) {
  const since = new Date(Date.now() - Math.min(Math.max(Number(hours) || 72, 1), 168) * 3600 * 1000);
  return ClientTelemetryEvent.find({
    clientId,
    createdAt: { $gte: since },
  })
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .lean();
}

module.exports = {
  scrubText,
  eventFingerprint,
  parseBrowser,
  captureToSentry,
  persistEvent,
  ingestClientEvents,
  ingestAnalyticsEvents,
  recordServerError,
  getClientHealthSummary,
  getClientTelemetryEvents,
  getProductUsageSummary,
  resolveFunnelState,
};
