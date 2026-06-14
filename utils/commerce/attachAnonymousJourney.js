'use strict';

const PixelEvent = require('../../models/PixelEvent');
const AdLead = require('../../models/AdLead');
const VisitorIdentity = require('../../models/VisitorIdentity');
const log = require('../core/logger')('AttachAnonymousJourney');

const JOURNEY_EVENT_LABELS = {
  page_view: 'Viewed page',
  product_added_to_cart: 'Added to cart',
  add_to_cart: 'Added to cart',
  checkout_started: 'Started checkout',
  contact_identified: 'Contact entered',
  checkout_contact_identified: 'Checkout contact captured',
};

function humanizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '') || '/';
    return path.length > 48 ? `${path.slice(0, 45)}…` : path;
  } catch {
    return String(url).slice(0, 48);
  }
}

function formatJourneyLogEntry(ev) {
  const base = JOURNEY_EVENT_LABELS[ev.eventName] || ev.eventName?.replace(/_/g, ' ') || 'Store event';
  const meta = ev.metadata || {};
  let product = meta.product?.title || meta.product?.name;
  const path = humanizeUrl(ev.url);

  if (!product && ev.eventName === 'page_view' && ev.url && ev.url.includes('/products/')) {
    try {
      const u = new URL(ev.url);
      const match = u.pathname.match(/\/products\/([^/]+)/);
      if (match && match[1]) {
        product = match[1].replace(/-/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
      }
    } catch (_) {
      /* ignore */
    }
  }

  let details = base;
  if (product) details += `: ${product}`;
  else if (path && path !== '/') details += `: ${path}`;
  return {
    action: 'pixel_journey',
    details,
    timestamp: ev.timestamp || new Date(),
    source: 'pixel_stitch',
  };
}

/**
 * Retroactively attach anonymous PixelEvents to a lead when identity is known.
 * Matches sessionId, visitorId, and checkoutToken (checkout funnel + VisitorIdentity lookup).
 */
async function attachAnonymousJourneyToLead({
  clientId,
  leadId,
  visitorId,
  sessionId,
  checkoutToken,
  maxEvents = 40,
}) {
  if (!clientId || !leadId) return { attached: 0 };

  const or = [];
  const token = checkoutToken ? String(checkoutToken).trim() : '';
  let resolvedVisitorId = visitorId ? String(visitorId).trim() : '';

  if (sessionId) or.push({ sessionId: String(sessionId) });
  if (resolvedVisitorId) or.push({ 'metadata.visitorId': resolvedVisitorId });

  if (token) {
    or.push({ 'metadata.checkoutToken': token });
  }

  if (token && !resolvedVisitorId) {
    const visitor = await VisitorIdentity.findOne({
      clientId,
      checkoutTokens: token,
    })
      .select('visitorId')
      .lean();
    if (visitor?.visitorId) {
      resolvedVisitorId = String(visitor.visitorId);
      or.push({ 'metadata.visitorId': resolvedVisitorId });
      or.push({ sessionId: resolvedVisitorId });
    }
  }

  if (!or.length) return { attached: 0 };

  const events = await PixelEvent.find({
    clientId,
    $and: [
      { $or: [{ leadId: null }, { leadId: { $exists: false } }] },
      { $or: or },
    ],
  })
    .sort({ timestamp: 1 })
    .limit(maxEvents)
    .lean();

  if (!events.length) return { attached: 0 };

  const eventIds = events.map((e) => e._id);
  const logEntries = events.map(formatJourneyLogEntry);

  await PixelEvent.updateMany({ _id: { $in: eventIds } }, { $set: { leadId } });

  await AdLead.updateOne(
    { _id: leadId, clientId },
    {
      $push: {
        activityLog: { $each: logEntries },
      },
    }
  );

  log.info(`[Journey] Attached ${events.length} pixel events to lead ${leadId}`);
  return { attached: events.length, events };
}

module.exports = {
  attachAnonymousJourneyToLead,
  formatJourneyLogEntry,
};
