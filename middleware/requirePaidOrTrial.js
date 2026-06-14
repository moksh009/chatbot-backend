'use strict';

const Subscription = require('../models/Subscription');
const Client = require('../models/Client');

const ALLOWLIST_PREFIXES = [
  '/api/auth',
  '/api/public',
  '/api/billing',
  '/api/shopify/webhook',
  '/api/shopify/compliance',
  '/api/razorpay',
  '/webhook',
  '/whatsapp-webhook',
  '/api/email/webhook',
  '/api/ig-automation/webhook',
  '/api/admin',
  '/api/health',
  '/api/capabilities',
  '/keepalive',
];

const subCache = new Map();
const CACHE_TTL_MS = 30_000;

function isAllowlisted(path) {
  const p = String(path || '');
  return ALLOWLIST_PREFIXES.some((prefix) => p.startsWith(prefix));
}

async function getSubscription(clientId) {
  const now = Date.now();
  const hit = subCache.get(clientId);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.sub;
  const sub = await Subscription.findOne({ clientId }).lean();
  let billingGraceUntil = null;
  if (!billingGraceUntil) {
    const client = await Client.findOne({ clientId }).select('billingGraceUntil trialActive').lean();
    billingGraceUntil = client?.billingGraceUntil;
  }
  const merged = { ...sub, billingGraceUntil: sub?.billingGraceUntil || billingGraceUntil };
  subCache.set(clientId, { at: now, sub: merged });
  return merged;
}

function requirePaidOrTrial() {
  return async (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (isAllowlisted(req.originalUrl || req.path)) return next();
    if (!req.user) return next();
    if (req.user.role === 'SUPER_ADMIN') return next();

    const sub = await getSubscription(req.user.clientId);
    const status = String(sub?.status || 'trial').toLowerCase();
    const grace =
      sub?.billingGraceUntil && new Date(sub.billingGraceUntil) > new Date();
    const allowed =
      ['active', 'trial'].includes(status) ||
      (status === 'past_due' && grace) ||
      (status === 'cancelled' && grace);

    if (allowed) return next();

    return res.status(402).json({
      error: 'payment_required',
      message: 'Subscription inactive. Upgrade to continue.',
      upgradeUrl: '/billing',
    });
  };
}

module.exports = { requirePaidOrTrial, isAllowlisted };
