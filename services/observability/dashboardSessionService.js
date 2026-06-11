'use strict';

const crypto = require('crypto');
const DashboardSession = require('../../models/DashboardSession');
const { isValidSessionId } = require('../../utils/telemetry/telemetryCookie');
function parseBrowser(userAgent = '') {
  const ua = String(userAgent);
  if (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS/i.test(ua)) return 'safari';
  if (/Chrome|Chromium|CriOS/i.test(ua)) return 'chrome';
  if (/Firefox/i.test(ua)) return 'firefox';
  if (/Edg/i.test(ua)) return 'edge';
  return 'other';
}

function buildVisitorKey(clientId, userId) {
  return crypto
    .createHash('sha256')
    .update(`${String(clientId)}:${String(userId)}`)
    .digest('hex')
    .slice(0, 32);
}

function newSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

async function countPriorSessions(clientId, userId, currentSessionId) {
  const count = await DashboardSession.countDocuments({
    clientId,
    userId,
    sessionId: { $ne: currentSessionId },
  }).maxTimeMS(5000);
  return count;
}

/**
 * Create or resume a dashboard session. Always refreshes lastSeen.
 * Returns session metadata for the SPA (Safari uses HttpOnly cookie + JSON fallback).
 */
async function touchOrCreateSession({
  sessionId: incomingSessionId,
  user,
  req,
  analyticsConsent = '',
  refreshCookie = true,
}) {
  if (!user?.clientId || !user?._id) {
    throw new Error('Missing user context for session');
  }

  const clientId = String(user.clientId);
  const userId = user._id;
  const visitorKey = buildVisitorKey(clientId, userId);
  const userAgent = req?.headers?.['user-agent'] || '';
  const browser = parseBrowser(userAgent);
  const now = new Date();

  let sessionId = isValidSessionId(incomingSessionId) ? incomingSessionId.trim() : null;
  if (!sessionId) sessionId = newSessionId();

  let row = await DashboardSession.findOne({ sessionId }).maxTimeMS(5000);

  if (row && String(row.userId) !== String(userId)) {
    sessionId = newSessionId();
    row = null;
  }

  const priorSessionCount = await countPriorSessions(clientId, userId, sessionId);
  const isReturning = priorSessionCount > 0;

  if (!row) {
    row = await DashboardSession.create({
      sessionId,
      visitorKey,
      clientId,
      userId,
      firstSeen: now,
      lastSeen: now,
      lastPingAt: now,
      pingCount: 1,
      userAgent: userAgent.slice(0, 400),
      browser,
      analyticsConsent: analyticsConsent || user.telemetryConsent || '',
      isReturning,
      priorSessionCount,
      cookieStrategy: refreshCookie ? 'httpOnly_first_party' : 'json_fallback',
    });
  } else {
    row.lastSeen = now;
    row.lastPingAt = now;
    row.pingCount = (row.pingCount || 0) + 1;
    row.userAgent = userAgent.slice(0, 400) || row.userAgent;
    row.browser = browser || row.browser;
    row.analyticsConsent = analyticsConsent || user.telemetryConsent || row.analyticsConsent;
    row.isReturning = isReturning;
    row.priorSessionCount = priorSessionCount;
    row.updatedAt = now;
    await row.save();
  }

  return {
    sessionId: row.sessionId,
    visitorKey: row.visitorKey,
    isReturning: row.isReturning,
    priorSessionCount: row.priorSessionCount,
    visitNumber: row.pingCount,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    browser: row.browser,
    cookieStrategy: 'httpOnly_first_party',
    cookieDomain: require('../../utils/telemetry/telemetryCookie').resolveTelemetryCookieDomain() || null,
  };
}

async function touchSessionById(sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  const now = new Date();
  return DashboardSession.findOneAndUpdate(
    { sessionId },
    { $set: { lastSeen: now, updatedAt: now } },
    { new: true }
  ).lean();
}

async function getSessionStatsForClient(clientId, { days = 7 } = {}) {
  const windowDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);

  const [activeSessions, returningSessions, totalPings] = await Promise.all([
    DashboardSession.countDocuments({ clientId, lastSeen: { $gte: since } }).maxTimeMS(5000),
    DashboardSession.countDocuments({
      clientId,
      lastSeen: { $gte: since },
      isReturning: true,
    }).maxTimeMS(5000),
    DashboardSession.aggregate([
      { $match: { clientId, lastSeen: { $gte: since } } },
      { $group: { _id: null, pings: { $sum: '$pingCount' } } },
    ]),
  ]);

  const pings = totalPings?.[0]?.pings || 0;
  const returningRate =
    activeSessions > 0 ? Math.round((returningSessions / activeSessions) * 100) : 0;

  return {
    days: windowDays,
    activeSessions,
    returningSessions,
    returningRate,
    totalPings: pings,
  };
}

async function getAdminSessionSummary({ hours = 24, limit = 50 } = {}) {
  const since = new Date(Date.now() - Math.min(Math.max(Number(hours) || 24, 1), 168) * 3600 * 1000);

  const rows = await DashboardSession.aggregate([
    { $match: { lastSeen: { $gte: since } } },
    {
      $group: {
        _id: '$clientId',
        activeSessions: { $sum: 1 },
        returningSessions: {
          $sum: { $cond: ['$isReturning', 1, 0] },
        },
        lastSeen: { $max: '$lastSeen' },
        browsers: { $addToSet: '$browser' },
        totalPings: { $sum: '$pingCount' },
      },
    },
    { $sort: { activeSessions: -1, lastSeen: -1 } },
    { $limit: Math.min(Number(limit) || 50, 200) },
  ]);

  const clientIds = rows.map((r) => r._id).filter(Boolean);
  const Client = require('../../models/Client');
  const clients = await Client.find({ clientId: { $in: clientIds } })
    .select('clientId businessName')
    .lean();
  const clientMap = Object.fromEntries(clients.map((c) => [c.clientId, c]));

  return rows.map((row) => ({
    clientId: row._id,
    businessName: clientMap[row._id]?.businessName || row._id,
    activeSessions: row.activeSessions,
    returningSessions: row.returningSessions,
    returningRate:
      row.activeSessions > 0
        ? Math.round((row.returningSessions / row.activeSessions) * 100)
        : 0,
    totalPings: row.totalPings,
    lastSeen: row.lastSeen,
    browsers: (row.browsers || []).filter(Boolean),
  }));
}

module.exports = {
  buildVisitorKey,
  newSessionId,
  touchOrCreateSession,
  touchSessionById,
  getSessionStatsForClient,
  getAdminSessionSummary,
};
