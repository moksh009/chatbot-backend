'use strict';

const User = require('../../models/User');
const ClientTelemetryEvent = require('../../models/ClientTelemetryEvent');
const DashboardSession = require('../../models/DashboardSession');

function maskSecret(value) {
  if (!value || typeof value !== 'string') return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length <= 8) return '••••••••';
  return `••••${s.slice(-4)}`;
}

function sanitizeClientForList(client) {
  const c = { ...client };
  c.whatsappToken = maskSecret(c.whatsappToken || c.config?.whatsappToken);
  c.shopifyAccessToken = maskSecret(c.shopifyAccessToken || c.config?.shopifyAccessToken);
  c.emailAppPassword = c.emailAppPassword ? 'configured' : null;
  c.hasGeminiKey = !!(c.geminiApiKey && String(c.geminiApiKey).trim());
  c.hasOpenaiKey = !!(c.openaiApiKey && String(c.openaiApiKey).trim());
  delete c.geminiApiKey;
  delete c.openaiApiKey;
  c.whatsappConnected = !!(c.phoneNumberId && (c.wabaId || c.whatsappToken));
  c.shopifyConnected = !!(c.shopDomain && (c.shopifyAccessToken || c.config?.shopifyAccessToken));
  return c;
}

async function enrichClientsForList(clients) {
  if (!clients.length) return [];

  const clientIds = clients.map((c) => c.clientId).filter(Boolean);
  const now = Date.now();
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000);

  const [users, errorAgg, sessionAgg] = await Promise.all([
    User.find({ clientId: { $in: clientIds } })
      .select('clientId email role')
      .lean(),
    ClientTelemetryEvent.aggregate([
      {
        $match: {
          clientId: { $in: clientIds },
          kind: { $in: ['error', 'api_failure', 'server_error'] },
          createdAt: { $gte: weekAgo },
        },
      },
      { $group: { _id: '$clientId', errorCount7d: { $sum: 1 } } },
    ]).catch(() => []),
    DashboardSession.aggregate([
      { $match: { clientId: { $in: clientIds } } },
      {
        $group: {
          _id: '$clientId',
          lastActive: { $max: '$lastSeen' },
          activeSessions24h: {
            $sum: { $cond: [{ $gte: ['$lastSeen', dayAgo] }, 1, 0] },
          },
        },
      },
    ]).catch(() => []),
  ]);

  const emailByClient = {};
  for (const u of users) {
    if (!emailByClient[u.clientId]) emailByClient[u.clientId] = u.email;
  }
  const errorsByClient = Object.fromEntries(errorAgg.map((r) => [r._id, r.errorCount7d]));
  const sessionsByClient = Object.fromEntries(
    sessionAgg.map((r) => [r._id, { lastActive: r.lastActive, activeSessions24h: r.activeSessions24h }])
  );

  return clients.map((raw) => {
    const base = sanitizeClientForList(raw);
    const sess = sessionsByClient[raw.clientId] || {};
    return {
      ...base,
      adminEmail: emailByClient[raw.clientId] || raw.adminEmail || null,
      errorCount7d: errorsByClient[raw.clientId] || 0,
      lastActive: sess.lastActive || raw.updatedAt || raw.createdAt || null,
      connectedToday: (sess.activeSessions24h || 0) > 0,
      messageCount24h: 0,
    };
  });
}

module.exports = {
  maskSecret,
  sanitizeClientForList,
  enrichClientsForList,
};
