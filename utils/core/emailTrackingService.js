'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const EmailTracking = require('../../models/EmailTracking');
const MessageEnvelope = require('../../models/MessageEnvelope');
const AdLead = require('../../models/AdLead');
const { htmlToPlainText } = require('./emailService');

const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function trackingSecret() {
  return (
    process.env.UNSUBSCRIBE_JWT_SECRET ||
    process.env.JWT_SECRET ||
    'topedge-email-tracking-dev-only'
  );
}

function getTrackingBaseUrl() {
  const base = String(process.env.EMAIL_TRACKING_DOMAIN || process.env.BACKEND_URL || 'https://api.topedgeai.com').replace(/\/$/, '');
  return base;
}

function signTrackingToken(payload, expiresIn = '90d') {
  return jwt.sign(payload, trackingSecret(), { expiresIn });
}

function verifyTrackingToken(token) {
  try {
    return jwt.verify(String(token || ''), trackingSecret());
  } catch {
    return null;
  }
}

function buildOpenPixelUrl(envelopeId, clientId) {
  const token = signTrackingToken({ envelopeId: String(envelopeId), clientId, type: 'open' });
  return `${getTrackingBaseUrl()}/api/email/track/open/${encodeURIComponent(token)}.gif`;
}

function buildClickTrackUrl(envelopeId, clientId, originalUrl) {
  const token = signTrackingToken({
    envelopeId: String(envelopeId),
    clientId,
    url: originalUrl,
    type: 'click',
  });
  return `${getTrackingBaseUrl()}/api/email/track/click/${encodeURIComponent(token)}`;
}

function buildUnsubscribeUrl(envelopeId, clientId, leadId) {
  const token = signTrackingToken({
    envelopeId: String(envelopeId),
    clientId,
    leadId: leadId ? String(leadId) : undefined,
    type: 'unsubscribe',
  });
  return `${getTrackingBaseUrl()}/api/email/unsubscribe/${encodeURIComponent(token)}`;
}

function escapeHtmlAttr(val) {
  return String(val || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function wrapLinksForTracking(html, envelopeId, clientId) {
  if (!html || !envelopeId) return html;
  const trackingHost = getTrackingBaseUrl().replace(/^https?:\/\//, '');
  return String(html).replace(
    /<a\s+([^>]*?)href=["']([^"']+)["']([^>]*)>/gi,
    (match, pre, href, post) => {
      const lower = href.toLowerCase();
      if (
        lower.startsWith('mailto:') ||
        lower.includes('/api/email/track/') ||
        lower.includes('/api/email/unsubscribe/') ||
        lower.includes(trackingHost + '/api/email/')
      ) {
        return match;
      }
      const tracked = buildClickTrackUrl(envelopeId, clientId, href);
      return `<a ${pre}href="${escapeHtmlAttr(tracked)}"${post}>`;
    }
  );
}

function appendTrackingPixel(html, envelopeId, clientId) {
  if (!html || !envelopeId) return html;
  const pixel = `<img src="${buildOpenPixelUrl(envelopeId, clientId)}" width="1" height="1" style="display:none" alt="" />`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${pixel}</body>`);
  }
  return `${html}${pixel}`;
}

function appendUnsubscribeFooter(html, unsubscribeUrl, storeName) {
  if (!html || !unsubscribeUrl) return html;
  const safeStore = escapeHtmlAttr(storeName || 'our store');
  const footer = `
<div style="text-align:center;margin-top:24px;font-size:11px;color:#94a3b8;font-family:Inter,-apple-system,sans-serif;">
  You're receiving this because you shopped at ${safeStore}.<br>
  <a href="${escapeHtmlAttr(unsubscribeUrl)}" style="color:#7C3AED;">Unsubscribe</a>
</div>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${footer}</body>`);
  }
  return `${html}${footer}`;
}

function prependUnsubscribeHeader(html, unsubscribeUrl) {
  if (!html || !unsubscribeUrl) return html;
  if (UNSUB_PLACEHOLDER_RE.test(html) || /\/api\/email\/unsubscribe\//i.test(html)) {
    return html;
  }
  const header = `<div style="padding:10px 20px;text-align:center;background:#f8fafc;border-bottom:1px solid #f1f5f9;font-family:Inter,-apple-system,sans-serif;font-size:11px;color:#94a3b8;">Prefer fewer emails? <a href="${escapeHtmlAttr(unsubscribeUrl)}" style="color:#7c3aed;text-decoration:underline;">Unsubscribe</a></div>`;
  return String(html).replace(/^(<div[^>]*>)/i, `$1${header}`);
}

function appendTopEdgeBranding(html) {
  if (!html || /automated by\s*topedge/i.test(html)) return html;
  const branding = `<div style="text-align:center;padding:10px 20px 6px;font-family:Inter,-apple-system,sans-serif;"><p style="margin:0;font-size:10px;color:#cbd5e1;">Automated by <a href="https://topedgeai.com" style="color:#a78bfa;text-decoration:none;">TopEdge AI</a></p></div>`;
  return `${html}${branding}`;
}

const UNSUB_PLACEHOLDER_RE = /\{\{\s*unsubscribe_(link|url)\s*\}\}/gi;

function injectUnsubscribePlaceholders(html, unsubscribeUrl) {
  if (!html || !unsubscribeUrl) return html;
  const linkHtml = `<a href="${escapeHtmlAttr(unsubscribeUrl)}" style="color:#7C3AED;text-decoration:underline;">Unsubscribe</a>`;
  return String(html).replace(UNSUB_PLACEHOLDER_RE, linkHtml);
}

function templateHasUnsubscribe(html) {
  if (!html) return false;
  const s = String(html);
  if (UNSUB_PLACEHOLDER_RE.test(s)) return true;
  return /\/api\/email\/unsubscribe\//i.test(s);
}

/**
 * Inject open pixel, click wrapping, and optional unsubscribe footer.
 */
function prepareTrackedEmailHtml({
  html,
  envelopeId,
  clientId,
  leadId,
  storeName,
  intent = 'marketing',
  includeUnsubscribe = null,
}) {
  if (!html) return html;
  let out = String(html);
  const shouldUnsub =
    includeUnsubscribe != null
      ? includeUnsubscribe
      : intent === 'marketing' || intent === 'utility';

  if (shouldUnsub && envelopeId) {
    const unsubUrl = buildUnsubscribeUrl(envelopeId, clientId, leadId);
    out = injectUnsubscribePlaceholders(out, unsubUrl);
    out = prependUnsubscribeHeader(out, unsubUrl);
    if (!templateHasUnsubscribe(out)) {
      out = appendUnsubscribeFooter(out, unsubUrl, storeName);
    }
  }

  out = appendTopEdgeBranding(out);

  if (envelopeId) {
    out = wrapLinksForTracking(out, envelopeId, clientId);
    out = appendTrackingPixel(out, envelopeId, clientId);
  }
  return out;
}

function detectMergeVariables(subject, bodyHtml) {
  const text = `${subject || ''} ${bodyHtml || ''}`;
  const matches = text.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, '')))];
}

async function recordEmailOpen(envelopeId, clientId, req = {}) {
  const now = new Date();
  await EmailTracking.create({
    envelopeId,
    clientId,
    type: 'open',
    ipAddress: req.ip || req.headers?.['x-forwarded-for'] || '',
    userAgent: req.headers?.['user-agent'] || '',
    timestamp: now,
  }).catch(() => {});

  try {
    // Do not combine $set on tracking.* with $setOnInsert on tracking — MongoDB error 40.
    await MessageEnvelope.updateOne(
      { _id: envelopeId, clientId },
      {
        $inc: { 'tracking.openCount': 1 },
        $set: { 'tracking.lastOpenAt': now },
      }
    );

    await MessageEnvelope.updateOne(
      { _id: envelopeId, clientId, 'tracking.firstOpenAt': null },
      { $set: { 'tracking.firstOpenAt': now } }
    );

    try {
      const { updateJourneyStepFromEnvelope } = require('../commerce/journeyAttributionHelper');
      await updateJourneyStepFromEnvelope({
        clientId,
        envelopeId,
        type: 'open',
        timestamp: now,
      });
    } catch (_) {
      /* non-fatal */
    }
  } catch (err) {
    const log = require('./logger')('EmailTracking');
    log.warn('recordEmailOpen envelope update failed', {
      envelopeId: String(envelopeId),
      clientId,
      message: err?.message,
    });
  }
}

async function recordEmailClick(envelopeId, clientId, url, req = {}) {
  const now = new Date();
  await EmailTracking.create({
    envelopeId,
    clientId,
    type: 'click',
    url: url || '',
    ipAddress: req.ip || req.headers?.['x-forwarded-for'] || '',
    userAgent: req.headers?.['user-agent'] || '',
    timestamp: now,
  }).catch(() => {});

  await MessageEnvelope.updateOne(
    { _id: envelopeId, clientId },
    { $inc: { 'tracking.clickCount': 1 } }
  );

  try {
    const { updateJourneyStepFromEnvelope } = require('../commerce/journeyAttributionHelper');
    await updateJourneyStepFromEnvelope({
      clientId,
      envelopeId,
      type: 'click',
      timestamp: now,
    });
  } catch (_) {
    /* non-fatal */
  }
}

async function processEmailUnsubscribe(token, req = {}) {
  const decoded = verifyTrackingToken(token);
  if (!decoded || decoded.type !== 'unsubscribe') {
    return { success: false, status: 400, message: 'Invalid unsubscribe link.' };
  }

  const { envelopeId, clientId, leadId } = decoded;
  let lead = null;

  if (leadId) {
    lead = await AdLead.findOne({ _id: leadId, clientId });
  }
  if (!lead && envelopeId) {
    const env = await MessageEnvelope.findOne({ _id: envelopeId, clientId }).select('contactId').lean();
    if (env?.contactId) {
      lead = await AdLead.findOne({ _id: env.contactId, clientId });
    }
  }

  if (!lead) {
    return { success: false, status: 404, message: 'Contact not found for this unsubscribe link.' };
  }

  lead.channelConsent = lead.channelConsent || {};
  lead.channelConsent.email = lead.channelConsent.email || {};
  lead.channelConsent.email.status = 'opted_out';
  lead.channelConsent.email.unsubscribeAt = new Date();
  lead.channelConsent.email.lastUpdated = new Date();
  if (!lead.channelConsent.email.unsubscribeToken) {
    lead.channelConsent.email.unsubscribeToken = crypto.randomBytes(24).toString('hex');
  }
  lead.optStatus = 'opted_out';
  lead.optOutDate = new Date();
  lead.optOutSource = 'unsubscribe_link';
  await lead.save();

  const SuppressionList = require('../../models/SuppressionList');
  await SuppressionList.findOneAndUpdate(
    { clientId, phone: (lead.email || '').toLowerCase(), channel: 'email' },
    { $set: { reason: 'opted_out', source: 'unsubscribe_link', addedAt: new Date() } },
    { upsert: true }
  );

  if (envelopeId) {
    await MessageEnvelope.updateOne(
      { _id: envelopeId, clientId },
      { $set: { 'tracking.unsubscribed': true, 'tracking.unsubscribedAt': new Date() } }
    );
    await EmailTracking.create({
      envelopeId,
      clientId,
      leadId: lead._id,
      type: 'unsubscribe',
      ipAddress: req.ip || '',
      userAgent: req.headers?.['user-agent'] || '',
      timestamp: new Date(),
    }).catch(() => {});
  }

  try {
    const { cancelAllAutomationsFor } = require('../messaging/cancelAllAutomationsFor');
    await cancelAllAutomationsFor({
      clientId,
      leadId: lead._id,
      phone: lead.phoneNumber,
      reason: 'unsubscribe_link',
      channels: 'all',
      actor: { type: 'lead', leadId: lead._id, source: 'unsubscribe_link' },
    });
  } catch (_) { /* non-fatal */ }

  try {
    const { emitToClient } = require('./socket');
    emitToClient(clientId, 'lead_email_consent_changed', {
      leadId: String(lead._id),
      email: lead.email,
      status: 'opted_out',
      source: 'unsubscribe_link',
    });
  } catch (_) { /* non-fatal */ }

  return { success: true, status: 200, message: 'You have been unsubscribed.', email: lead.email };
}

function renderUnsubscribePage(token, email = '') {
  const safeEmail = escapeHtmlAttr(email);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribe</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#f8fafc;margin:0;padding:40px 16px;color:#0f172a}
.card{max-width:420px;margin:0 auto;background:#fff;border:1px solid #efeaf8;border-radius:16px;padding:32px;box-shadow:0 8px 30px -12px rgba(124,58,237,.15)}
h1{font-size:20px;margin:0 0 8px}p{color:#64748b;font-size:14px;line-height:1.6}
button{background:#7C3AED;color:#fff;border:none;border-radius:999px;padding:12px 24px;font-size:14px;font-weight:600;cursor:pointer;margin-top:20px}
button:hover{background:#6d28d9}</style></head><body><div class="card">
<h1>Unsubscribe from emails</h1>
<p>Stop marketing emails${safeEmail ? ` to <strong>${safeEmail}</strong>` : ''}. Order updates may still be sent when required.</p>
<form method="POST" action="/api/email/unsubscribe"><input type="hidden" name="token" value="${escapeHtmlAttr(token)}" />
<button type="submit">Confirm unsubscribe</button></form></div></body></html>`;
}

function renderUnsubscribeSuccessPage() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unsubscribed</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#f8fafc;margin:0;padding:40px 16px;text-align:center;color:#0f172a}
.card{max-width:420px;margin:0 auto;background:#fff;border:1px solid #efeaf8;border-radius:16px;padding:32px}
h1{font-size:20px;color:#7C3AED}</style></head><body><div class="card">
<h1>You're unsubscribed</h1><p style="color:#64748b">You won't receive marketing emails from this store anymore.</p></div></body></html>`;
}

module.exports = {
  TRANSPARENT_GIF,
  getTrackingBaseUrl,
  signTrackingToken,
  verifyTrackingToken,
  buildOpenPixelUrl,
  buildClickTrackUrl,
  buildUnsubscribeUrl,
  prepareTrackedEmailHtml,
  detectMergeVariables,
  recordEmailOpen,
  recordEmailClick,
  processEmailUnsubscribe,
  renderUnsubscribePage,
  renderUnsubscribeSuccessPage,
  htmlToPlainText,
};
