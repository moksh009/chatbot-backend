const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const {
  ingestClientEvents,
  ingestAnalyticsEvents,
} = require('../services/observability/telemetryIngestService');
const { touchOrCreateSession } = require('../services/observability/dashboardSessionService');
const {
  SESSION_COOKIE,
  sessionCookieOptions,
  isValidSessionId,
} = require('../utils/telemetry/telemetryCookie');

const router = express.Router();
const log = require('../utils/core/logger')('TelemetryAPI');

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const [key, ...rest] = part.trim().split('=');
      if (!key) return [];
      return [key, decodeURIComponent(rest.join('=') || '')];
    }).filter((entry) => entry.length === 2)
  );
}

function resolveSessionId(req) {
  const cookies = parseCookies(req);
  const fromCookie = cookies[SESSION_COOKIE];
  const fromBody = req.body?.sessionId;
  if (isValidSessionId(fromCookie)) return fromCookie.trim();
  if (isValidSessionId(fromBody)) return fromBody.trim();
  return null;
}

function attachSessionId(req) {
  req.teSessionId = resolveSessionId(req);
}

function setSessionCookie(res, sessionId) {
  res.cookie(SESSION_COOKIE, sessionId, sessionCookieOptions());
}

function isSuperAdminUser(user) {
  return user?.role === 'SUPER_ADMIN';
}

/** Merchants only need sessionId for cookie fallback — analytics fields are admin-only. */
function sanitizeSessionPayload(user, meta = {}) {
  const base = {
    success: true,
    sessionId: meta.sessionId,
    at: new Date().toISOString(),
  };
  if (isSuperAdminUser(user)) {
    return { ...base, ...meta, success: true };
  }
  return base;
}

const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Telemetry rate limit exceeded' },
});

async function handleSessionTouch(req, res, { lightPing = false } = {}) {
  try {
    if (!req.user?.clientId) {
      return res.json({
        success: true,
        skipped: true,
        reason: 'no_tenant_context',
        at: new Date().toISOString(),
      });
    }
    attachSessionId(req);
    const analyticsConsent =
      req.body?.analyticsConsent === true
        ? 'analytics'
        : req.user?.telemetryConsent || '';

    const meta = await touchOrCreateSession({
      sessionId: req.teSessionId,
      user: req.user,
      req,
      analyticsConsent,
      refreshCookie: true,
    });

    setSessionCookie(res, meta.sessionId);
    req.teSessionId = meta.sessionId;

    res.json(sanitizeSessionPayload(req.user, { ...meta, lightPing }));
  } catch (e) {
    log.error('session touch failed', { error: e.message });
    res.status(500).json({ success: false, message: 'Session init failed' });
  }
}

router.post('/session', protect, telemetryLimiter, (req, res) => {
  handleSessionTouch(req, res, { lightPing: false });
});

router.post('/session/ping', protect, telemetryLimiter, (req, res) => {
  handleSessionTouch(req, res, { lightPing: true });
});

router.get('/session', protect, telemetryLimiter, async (req, res) => {
  try {
    attachSessionId(req);
    if (!req.teSessionId) {
      return res.json({
        success: true,
        hasSession: false,
        cookieStrategy: 'httpOnly_first_party',
      });
    }
    const DashboardSession = require('../models/DashboardSession');
    const row = await DashboardSession.findOne({ sessionId: req.teSessionId }).lean();
    if (!row || String(row.userId) !== String(req.user._id)) {
      return res.json({ success: true, hasSession: false });
    }
    if (isSuperAdminUser(req.user)) {
      return res.json({
        success: true,
        hasSession: true,
        sessionId: row.sessionId,
        isReturning: row.isReturning,
        priorSessionCount: row.priorSessionCount,
        visitNumber: row.pingCount,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
        browser: row.browser,
      });
    }
    res.json({ success: true, hasSession: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/events', protect, telemetryLimiter, async (req, res) => {
  try {
    attachSessionId(req);
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    if (!events.length) {
      return res.status(400).json({ success: false, message: 'events array required' });
    }

    const analyticsConsent = req.body?.analyticsConsent === true;
    const essential = await ingestClientEvents(req.user, events, req);

    let analytics = { accepted: [] };
    if (analyticsConsent) {
      analytics = await ingestAnalyticsEvents(req.user, events, req);
    }

    if (req.teSessionId) {
      const { touchSessionById } = require('../services/observability/dashboardSessionService');
      touchSessionById(req.teSessionId).catch(() => {});
    }

    res.json({
      success: true,
      essential,
      analytics,
      sessionId: req.teSessionId || null,
    });
  } catch (e) {
    log.error('telemetry ingest failed', { error: e.message });
    res.status(500).json({ success: false, message: 'Telemetry ingest failed' });
  }
});

router.get('/consent', protect, telemetryLimiter, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('telemetryConsent telemetryConsentUpdatedAt').lean();
    res.json({
      success: true,
      consent: user?.telemetryConsent || '',
      updatedAt: user?.telemetryConsentUpdatedAt || null,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.patch('/consent', protect, telemetryLimiter, async (req, res) => {
  try {
    const allowed = ['', 'essential', 'analytics'];
    const consent = req.body?.consent;
    if (!allowed.includes(consent)) {
      return res.status(400).json({ success: false, message: 'Invalid consent value' });
    }
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    user.telemetryConsent = consent;
    user.telemetryConsentUpdatedAt = new Date();
    await user.save();
    res.json({
      success: true,
      consent: user.telemetryConsent,
      updatedAt: user.telemetryConsentUpdatedAt,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
