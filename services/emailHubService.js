'use strict';

const crypto = require('crypto');
const MessageEnvelope = require('../models/MessageEnvelope');
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const ScheduledMessage = require('../models/ScheduledMessage');
const mongoose = require('mongoose');
const { isWorkspaceEmailReady, sendWorkspaceEmailDirect, htmlToPlainText } = require('../utils/core/emailService');
const { dispatchTrackedEmail } = require('../utils/core/dispatchTrackedEmail');
const { checkEmailDailyLimit, getEmailDailyUsage, incrementEmailCount } = require('../utils/core/emailRateLimiter');
const { bumpTemplateSentStats } = require('./emailTemplateService');
const { mergeEmailForLead, KNOWN_EMAIL_TOKEN_KEYS } = require('../utils/core/emailMergeFields');
const { checkConsent } = require('../utils/messaging/checks/checkConsent');
const { checkSuppression } = require('../utils/messaging/checks/checkSuppression');
const { emailIdempotencyKey } = require('../utils/messaging/customerEmailSend');
const { emitToClient } = require('../utils/core/socket');

function hubEnvelopeIdempotencyKey(clientId, email, subject, suffix = '') {
  const base = emailIdempotencyKey(clientId, email, subject);
  if (!suffix) return `${base}:hub:${Date.now()}`;
  return `${base}:hub:${suffix}`;
}

async function assertLeadCanReceiveMarketingEmail(clientId, lead, email) {
  const contact = lead || { email, channelConsent: {} };
  const consent = checkConsent({ contact, channel: 'email', intent: 'marketing' });
  if (!consent.pass) {
    const msg =
      consent.reason === 'email_bounced'
        ? 'This email address has bounced and cannot receive mail.'
        : 'This contact unsubscribed from marketing email.';
    const err = new Error(msg);
    err.status = 400;
    err.code = consent.reason || 'email_opted_out';
    throw err;
  }
  const suppress = await checkSuppression({
    clientId,
    channel: 'email',
    contact: { email: String(email || contact.email || '').trim().toLowerCase() },
  });
  if (!suppress.pass) {
    const err = new Error('This email is on the suppression list.');
    err.status = 400;
    err.code = suppress.reason || 'suppressed';
    throw err;
  }
}

const SOURCE_LABELS = {
  'workers/sequenceDispatchWorker': 'Sequence',
  'workers/campaignDispatchWorker': 'Campaign',
  'cron/abandonedCartScheduler': 'Cart recovery',
  'cron/abandonedCartScheduler:browse': 'Browse recovery',
  'cron/scheduledMessageCron': 'Scheduled',
  'routes/leads:bulk-email': 'Bulk email',
  'routes/conversations:send-email': 'Live chat',
  'routes/email-hub:send': 'Email hub',
  'routes/email-hub:bulk-send': 'Email hub',
  'product_watch_restock': 'Restock alert',
  'rtoProtectionService:ndr_rescue': 'NDR rescue',
};

function validEmailQuery() {
  return { $exists: true, $ne: '', $regex: /@/i };
}

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceMatchesFilter(formattedSource, rawSource, filterLabel) {
  if (!filterLabel || filterLabel === 'all') return true;
  const src = String(formattedSource || '');
  const raw = String(rawSource || '');
  if (src === filterLabel || src.startsWith(`${filterLabel}:`)) return true;
  if (filterLabel === 'Order' && src.startsWith('Order')) return true;
  if (filterLabel === 'Cart recovery' && /cart recovery/i.test(src)) return true;
  if (filterLabel === 'Email hub' && (raw.includes('email-hub') || src === 'Email hub')) return true;
  if (filterLabel === 'Sequence' && (raw.includes('sequence') || src.startsWith('Sequence'))) return true;
  if (filterLabel === 'Campaign' && (raw.includes('campaign') || src === 'Campaign')) return true;
  if (filterLabel === 'Live chat' && (raw.includes('conversation') || src === 'Live chat')) return true;
  if (filterLabel === 'Scheduled' && (raw.includes('scheduledMessage') || raw.includes('Scheduled') || src === 'Scheduled')) return true;
  if (filterLabel === 'Automation' && src === 'Automation') return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function labelSource(source = '') {
  if (!source) return 'Automation';
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  if (source.includes('sequence')) return 'Sequence';
  if (source.includes('campaign')) return 'Campaign';
  if (source.includes('leads')) return 'Bulk email';
  if (source.includes('conversation')) return 'Live chat';
  if (source.includes('abandonedCart')) return 'Cart recovery';
  return 'Automation';
}

const ORDER_RULE_LABELS = {
  sys_fulfillment_unfulfilled: 'Order placed',
  sys_shipment_in_transit: 'In transit',
  sys_shipment_out_for_delivery: 'Out for delivery',
  sys_shipment_delivered: 'Delivered',
  sys_shipment_attempted_delivery: 'Attempted delivery',
  sys_shipment_failure: 'Failed delivery (RTO)',
  /** Legacy ids — historical email log rows */
  sys_financial_paid: 'Order placed (legacy)',
  sys_financial_pending: 'Pending (legacy)',
  sys_financial_refunded: 'Refunded (legacy)',
  sys_financial_partially_paid: 'Partially paid (legacy)',
  sys_financial_voided: 'Voided (legacy)',
  sys_fulfillment_fulfilled: 'Shipped (legacy)',
  sys_fulfillment_partial: 'Partially fulfilled (legacy)',
  sys_shipment_ready_for_pickup: 'Ready for pickup',
};

function titleCase(str = '') {
  return String(str || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatEmailLogSource(ctx = {}) {
  const sequenceName = ctx.sequenceName || null;
  if (sequenceName) return `Sequence: ${sequenceName}`;

  const src = String(ctx.source || '');
  const ruleId = String(ctx.ruleId || '');

  if (
    src.includes('orderStatus') ||
    src.includes('order_automation') ||
    ruleId.startsWith('sys_financial_') ||
    ruleId.startsWith('sys_fulfillment_') ||
    ruleId.startsWith('sys_shipment_')
  ) {
    if (ORDER_RULE_LABELS[ruleId]) return `Order: ${ORDER_RULE_LABELS[ruleId]}`;
    if (ctx.statusKey) {
      const parts = String(ctx.statusKey).split('_status_');
      const statusPart = parts.length > 1 ? parts[parts.length - 1] : ctx.statusKey;
      return `Order: ${titleCase(statusPart)}`;
    }
    return 'Order update';
  }

  if (src.includes('abandonedCart') || src.includes('cart_recovery') || ruleId.startsWith('sys_cart_')) {
    const step = ctx.step || ctx.stepNum || ctx.cartStep;
    if (step != null && step !== '') return `Cart recovery step ${step}`;
    return 'Cart recovery';
  }

  if (src.includes('scheduledMessage') || src.includes('scheduledMessageCron')) {
    return 'Scheduled';
  }

  return labelSource(src);
}

function newBulkJobId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function emitEmailBulkProgress(clientId, payload) {
  emitToClient(clientId, 'email_bulk_progress', payload);
}

function emitEmailBulkCompleted(clientId, payload) {
  emitToClient(clientId, 'email_bulk_completed', payload);
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

/**
 * Repair envelopes stuck as `queued` after Gmail send succeeded but post-send
 * bookkeeping failed (historical redis.incrBy bug). Skips scheduled sends.
 */
/** Sync hub envelopes still `queued` when ScheduledMessage already sent/failed. */
async function reconcileScheduledHubEnvelopes(clientId) {
  const since = daysAgo(14);
  const stuck = await MessageEnvelope.find({
    clientId,
    channel: 'email',
    status: 'queued',
    createdAt: { $gte: since },
    'context.scheduledMessageId': { $exists: true, $ne: '' },
  })
    .select('_id context.scheduledMessageId')
    .lean();

  if (!stuck.length) return 0;

  const ids = stuck
    .map((row) => row.context?.scheduledMessageId)
    .filter(Boolean);
  const scheduled = await ScheduledMessage.find({ _id: { $in: ids } })
    .select('_id status')
    .lean();
  const statusById = new Map(scheduled.map((s) => [String(s._id), s.status]));

  let updated = 0;
  for (const row of stuck) {
    const schedStatus = statusById.get(String(row.context.scheduledMessageId));
    if (schedStatus === 'sent') {
      await MessageEnvelope.updateOne(
        { _id: row._id, status: 'queued' },
        { status: 'sent', sentAt: new Date() }
      );
      updated += 1;
    } else if (schedStatus === 'failed' || schedStatus === 'cancelled') {
      await MessageEnvelope.updateOne(
        { _id: row._id, status: 'queued' },
        {
          status: schedStatus === 'failed' ? 'failed' : 'blocked',
          reason: schedStatus === 'failed' ? 'scheduled_send_failed' : 'scheduled_cancelled',
          failedAt: new Date(),
        }
      );
      updated += 1;
    }
  }
  return updated;
}

async function reconcileStuckHubEnvelopes(clientId) {
  const graceCutoff = new Date(Date.now() - 45_000);
  const since = daysAgo(14);
  const result = await MessageEnvelope.updateMany(
    {
      clientId,
      channel: 'email',
      status: 'queued',
      createdAt: { $gte: since, $lte: graceCutoff },
      'context.scheduledMessageId': { $exists: false },
      $or: [
        { 'context.source': /email-hub/i },
        { 'context.source': /routes\/email-hub/i },
      ],
    },
    [
      {
        $set: {
          status: 'sent',
          sentAt: { $ifNull: ['$sentAt', '$createdAt'] },
          'context.reconciledAt': new Date(),
          'context.reconcileReason': 'send_succeeded_before_status_persist',
        },
      },
    ]
  );
  return result.modifiedCount || 0;
}

async function getEmailHubSummary(clientId) {
  await reconcileScheduledHubEnvelopes(clientId).catch(() => {});
  await reconcileStuckHubEnvelopes(clientId).catch(() => {});
  const client = await Client.findOne({ clientId }).lean();
  const since7 = daysAgo(7);
  const since30 = daysAgo(30);

  const [stats7, stats30, sequenceAgg, opened7, clicked7] = await Promise.all([
    MessageEnvelope.aggregate([
      { $match: { clientId, channel: 'email', createdAt: { $gte: since7 } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    MessageEnvelope.aggregate([
      { $match: { clientId, channel: 'email', createdAt: { $gte: since30 } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    FollowUpSequence.aggregate([
      { $match: { clientId } },
      { $unwind: '$steps' },
      { $match: { 'steps.type': 'email' } },
      {
        $group: {
          _id: '$steps.status',
          count: { $sum: 1 },
        },
      },
    ]),
    MessageEnvelope.countDocuments({
      clientId,
      channel: 'email',
      status: 'sent',
      createdAt: { $gte: since7 },
      'tracking.openCount': { $gt: 0 },
    }),
    MessageEnvelope.countDocuments({
      clientId,
      channel: 'email',
      status: 'sent',
      createdAt: { $gte: since7 },
      'tracking.clickCount': { $gt: 0 },
    }),
  ]);

  const toMap = (rows) => rows.reduce((acc, r) => ({ ...acc, [r._id]: r.count }), {});

  const s7 = toMap(stats7);
  const s30 = toMap(stats30);
  const seq = toMap(sequenceAgg);

  const emailReady = client ? await isWorkspaceEmailReady(client) : false;
  const dailyUsage = await getEmailDailyUsage(clientId);

  const totalWithEmail = await AdLead.countDocuments({
    clientId,
    email: validEmailQuery(),
  });

  return {
    connection: {
      connected: emailReady,
      gmailAddress: client?.gmailAddress || client?.emailUser || null,
      method: client?.emailMethod || null,
    },
    emailsToday: dailyUsage.sent,
    dailyLimit: dailyUsage.limit,
    emailsRemaining: dailyUsage.remaining,
    totalWithEmail,
    last7d: {
      sent: s7.sent || 0,
      failed: s7.failed || 0,
      blocked: s7.blocked || 0,
      duplicate: s7.duplicate || 0,
      opened: opened7 || 0,
      clicked: clicked7 || 0,
      total: Object.values(s7).reduce((a, b) => a + b, 0),
    },
    last30d: {
      sent: s30.sent || 0,
      failed: s30.failed || 0,
      blocked: s30.blocked || 0,
      total: Object.values(s30).reduce((a, b) => a + b, 0),
    },
    sequenceEmailSteps: {
      sent: seq.sent || 0,
      pending: (seq.pending || 0) + (seq.queued || 0) + (seq.processing || 0) + (seq.retrying || 0),
      failed: seq.failed || 0,
      cancelled: seq.cancelled || 0,
      skipped: seq.skipped || 0,
      total: Object.values(seq).reduce((a, b) => a + b, 0),
    },
  };
}

async function getEmailHubLogs(clientId, { page = 1, limit = 50, status, source, days = 30 } = {}) {
  await reconcileScheduledHubEnvelopes(clientId).catch(() => {});
  await reconcileStuckHubEnvelopes(clientId).catch(() => {});
  const since = daysAgo(Math.min(Math.max(Number(days) || 30, 1), 90));
  const take = Math.min(100, Math.max(1, Number(limit)));
  const pageNum = Math.max(1, Number(page));
  const skip = (pageNum - 1) * take;

  const filter = { clientId, channel: 'email', createdAt: { $gte: since } };
  if (status && status !== 'all') filter.status = status;

  const needsSourceFilter = source && source !== 'all';
  const fetchLimit = needsSourceFilter ? 500 : take;
  const fetchSkip = needsSourceFilter ? 0 : skip;

  const [rows, dbTotal] = await Promise.all([
    MessageEnvelope.find(filter)
      .sort({ createdAt: -1 })
      .skip(fetchSkip)
      .limit(fetchLimit)
      .lean(),
    MessageEnvelope.countDocuments(filter),
  ]);

  const contactIds = [...new Set(rows.map((r) => String(r.contactId)).filter(Boolean))];
  const contacts = contactIds.length
    ? await AdLead.find({ _id: { $in: contactIds } })
        .select('name email phone')
        .lean()
    : [];
  const contactMap = new Map(contacts.map((c) => [String(c._id), c]));

  let mapped = rows.map((row) => {
    const contact = row.contactId ? contactMap.get(String(row.contactId)) : null;
    const ctx = row.context || {};
    const src = ctx.source || '';
    const sequenceName = ctx.sequenceName || null;
    const stepLabel =
      ctx.stepIndex != null && sequenceName
        ? `${sequenceName} · Step ${Number(ctx.stepIndex) + 1}`
        : sequenceName || null;
    const subjectRaw = ctx.subject || row.templateName || '';
    const subject =
      subjectRaw && subjectRaw !== '—'
        ? subjectRaw
        : stepLabel ||
          (String(src).includes('automation') ? 'Order update' : null) ||
          (String(src).includes('cart') ? 'Cart recovery' : null) ||
          '—';
    return {
      id: String(row._id),
      status: row.status,
      intent: row.intent,
      blockedBy: row.blockedBy,
      reason: row.reason || '',
      subject,
      recipientEmail: ctx.recipientEmail || contact?.email || '—',
      recipientName: contact?.name || '—',
      source: formatEmailLogSource(ctx),
      sourceRaw: src,
      sequenceId: ctx.sequenceId || null,
      sequenceName,
      stepIndex: ctx.stepIndex != null ? ctx.stepIndex : null,
      campaignId: ctx.campaignId || null,
      messageId: row.messageId || '',
      sentAt: row.sentAt || row.createdAt,
      failedAt: row.failedAt,
      createdAt: row.createdAt,
      tracking: {
        openCount: row.tracking?.openCount || 0,
        clickCount: row.tracking?.clickCount || 0,
        firstOpenAt: row.tracking?.firstOpenAt || null,
        bounced: !!row.tracking?.bounced,
        unsubscribed: !!row.tracking?.unsubscribed,
      },
    };
  });

  if (source && source !== 'all') {
    mapped = mapped.filter((r) => sourceMatchesFilter(r.source, r.sourceRaw, source));
  }

  const filteredTotal = needsSourceFilter ? mapped.length : dbTotal;
  const pagedRows = needsSourceFilter ? mapped.slice(skip, skip + take) : mapped;

  return {
    rows: pagedRows,
    pagination: {
      page: pageNum,
      limit: take,
      total: filteredTotal,
      pages: Math.ceil(filteredTotal / take) || 1,
    },
  };
}

async function getEmailHubSequenceMails(clientId, { limit = 80, status } = {}) {
  const take = Math.min(150, Math.max(1, Number(limit) || 80));
  const seqs = await FollowUpSequence.find({ clientId })
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean();

  const leadIds = [...new Set(seqs.map((s) => s.leadId).filter(Boolean))];
  const leads = leadIds.length
    ? await AdLead.find({ _id: { $in: leadIds } }).select('name email phoneNumber').lean()
    : [];
  const leadMap = new Map(leads.map((l) => [String(l._id), l]));

  const seqIds = seqs.map((s) => String(s._id));
  const envelopes = seqIds.length
    ? await MessageEnvelope.find({
        clientId,
        channel: 'email',
        'context.sequenceId': { $in: seqIds },
      })
        .select('context tracking sentAt status')
        .lean()
    : [];

  const trackingMap = new Map();
  for (const env of envelopes) {
    const ctx = env.context || {};
    if (ctx.stepIndex == null || !ctx.sequenceId) continue;
    const key = `${ctx.sequenceId}:${ctx.stepIndex}`;
    trackingMap.set(key, {
      openCount: env.tracking?.openCount || 0,
      clickCount: env.tracking?.clickCount || 0,
      firstOpenAt: env.tracking?.firstOpenAt || null,
      envelopeStatus: env.status,
      sentAt: env.sentAt || null,
    });
  }

  const rows = [];
  for (const seq of seqs) {
    const lead = seq.leadId ? leadMap.get(String(seq.leadId)) : null;
    (seq.steps || []).forEach((step, idx) => {
      if (step.type !== 'email') return;
      if (status && status !== 'all' && step.status !== status) return;
      const trackKey = `${String(seq._id)}:${idx}`;
      const tracking = trackingMap.get(trackKey) || null;
      rows.push({
        sequenceId: String(seq._id),
        sequenceName: seq.name || 'Untitled sequence',
        sequenceStatus: seq.status,
        stepIndex: idx,
        stepStatus: step.status,
        subject: step.subject || '—',
        recipientEmail: lead?.email || seq.email || '—',
        recipientName: lead?.name || seq.name || '—',
        sendAt: step.sendAt,
        sentAt: step.sentAt || tracking?.sentAt,
        nextAttemptAt: step.nextAttemptAt || null,
        failureReason: step.failureReason || step.errorLog || '',
        skipReason: step.skipReason || '',
        leadId: seq.leadId ? String(seq.leadId) : null,
        tracking: tracking
          ? {
              openCount: tracking.openCount,
              clickCount: tracking.clickCount,
              firstOpenAt: tracking.firstOpenAt,
            }
          : null,
      });
    });
  }

  rows.sort((a, b) => {
    const ta = new Date(b.sentAt || b.sendAt || 0).getTime();
    const tb = new Date(a.sentAt || a.sendAt || 0).getTime();
    return ta - tb;
  });

  return { rows: rows.slice(0, take), total: rows.length };
}

function buildAudienceLeadFilter(clientId, { search = '', filter = 'all' } = {}) {
  const leadFilter = { clientId, email: validEmailQuery() };
  if (search && String(search).trim()) {
    const q = escapeRegex(String(search).trim());
    leadFilter.$or = [
      { name: { $regex: q, $options: 'i' } },
      { email: { $regex: q, $options: 'i' } },
    ];
  }

  if (filter === 'bounced') {
    leadFilter.emailBounced = true;
  } else if (filter === 'unsubscribed') {
    leadFilter['channelConsent.email.status'] = 'opted_out';
  } else if (filter === 'valid') {
    leadFilter.emailBounced = { $ne: true };
    leadFilter['channelConsent.email.status'] = { $ne: 'opted_out' };
  }

  return leadFilter;
}

const PLACEHOLDER_AUDIENCE_NAMES = new Set(['', '—', '-', 'checkout customer', 'guest', 'a customer']);

function isPlaceholderAudienceName(name) {
  return PLACEHOLDER_AUDIENCE_NAMES.has(String(name || '').trim().toLowerCase());
}

function normalizeAudienceDisplayName(name) {
  const trimmed = String(name || '').trim();
  if (trimmed && !isPlaceholderAudienceName(trimmed)) return trimmed;
  return '—';
}

function pickCanonicalAudienceRow(a, b) {
  const aBad = isPlaceholderAudienceName(a.name);
  const bBad = isPlaceholderAudienceName(b.name);
  let winner;
  if (aBad !== bBad) winner = aBad ? b : a;
  else if ((b.sentCount || 0) !== (a.sentCount || 0)) {
    winner = (b.sentCount || 0) > (a.sentCount || 0) ? b : a;
  } else {
    const ta = new Date(a.lastSentAt || 0).getTime();
    const tb = new Date(b.lastSentAt || 0).getTime();
    if (tb !== ta) winner = tb > ta ? b : a;
    else if (a.unsubscribed !== b.unsubscribed) winner = a.unsubscribed ? b : a;
    else if (a.emailBounced !== b.emailBounced) winner = a.emailBounced ? b : a;
    else winner = a;
  }
  const loser = winner === a ? b : a;
  const bestName = !isPlaceholderAudienceName(winner.name)
    ? winner.name
    : !isPlaceholderAudienceName(loser.name)
      ? loser.name
      : winner.name;
  return { ...winner, name: normalizeAudienceDisplayName(bestName) };
}

function dedupeAudienceRowsByEmail(rows = []) {
  const byEmail = new Map();
  for (const row of rows) {
    const key = String(row.email || '').trim().toLowerCase();
    if (!key || key === '—') continue;
    const existing = byEmail.get(key);
    byEmail.set(key, existing ? pickCanonicalAudienceRow(existing, row) : { ...row, name: normalizeAudienceDisplayName(row.name) });
  }
  return [...byEmail.values()];
}

async function countDistinctAudienceEmails(clientId, extraFilter = {}) {
  const emails = await AdLead.distinct('email', {
    clientId,
    email: validEmailQuery(),
    ...extraFilter,
  });
  return emails.filter((e) => String(e || '').trim()).length;
}

async function mapLeadsToAudienceRows(clientId, leads) {
  const leadIds = leads.map((l) => l._id);
  const emails = [...new Set(leads.map((l) => String(l.email || '').trim().toLowerCase()).filter(Boolean))];

  const statsAgg =
    emails.length > 0
      ? await MessageEnvelope.aggregate([
          {
            $match: {
              clientId,
              channel: 'email',
              status: 'sent',
              $or: [
                { contactId: { $in: leadIds } },
                { 'context.recipientEmail': { $in: emails } },
              ],
            },
          },
          {
            $addFields: {
              emailKey: {
                $toLower: {
                  $trim: { input: { $ifNull: ['$context.recipientEmail', ''] } },
                },
              },
            },
          },
          {
            $match: {
              $or: [{ emailKey: { $in: emails } }, { contactId: { $in: leadIds } }],
            },
          },
          {
            $group: {
              _id: {
                emailKey: '$emailKey',
                contactId: '$contactId',
              },
              sentCount: { $sum: 1 },
              lastSentAt: { $max: '$sentAt' },
            },
          },
        ])
      : [];

  const statsByContactId = new Map();
  const statsByEmail = new Map();
  for (const row of statsAgg) {
    const count = row.sentCount || 0;
    const last = row.lastSentAt || null;
    const emailKey = row._id?.emailKey;
    const contactId = row._id?.contactId ? String(row._id.contactId) : null;
    if (contactId) {
      const prev = statsByContactId.get(contactId);
      statsByContactId.set(contactId, {
        sentCount: (prev?.sentCount || 0) + count,
        lastSentAt: !prev?.lastSentAt || (last && new Date(last) > new Date(prev.lastSentAt)) ? last : prev.lastSentAt,
      });
    }
    if (emailKey) {
      const prev = statsByEmail.get(emailKey);
      statsByEmail.set(emailKey, {
        sentCount: (prev?.sentCount || 0) + count,
        lastSentAt: !prev?.lastSentAt || (last && new Date(last) > new Date(prev.lastSentAt)) ? last : prev.lastSentAt,
      });
    }
  }

  return leads.map((lead) => {
    const email = String(lead.email || '').trim().toLowerCase();
    const byId = statsByContactId.get(String(lead._id));
    const byEmail = statsByEmail.get(email);
    const pickStat = (a, b) => {
      if (!a && !b) return { sentCount: 0, lastSentAt: null };
      if (!a) return b;
      if (!b) return a;
      const sentCount = Math.max(a.sentCount || 0, b.sentCount || 0);
      const lastA = a.lastSentAt ? new Date(a.lastSentAt).getTime() : 0;
      const lastB = b.lastSentAt ? new Date(b.lastSentAt).getTime() : 0;
      return {
        sentCount,
        lastSentAt: lastB > lastA ? b.lastSentAt : a.lastSentAt,
      };
    };
    const stat = pickStat(byId, byEmail);
    return {
      leadId: String(lead._id),
      name: normalizeAudienceDisplayName(lead.name),
      email: lead.email || '—',
      sentCount: stat.sentCount || 0,
      lastSentAt: stat.lastSentAt || null,
      emailBounced: !!lead.emailBounced,
      emailBouncedAt: lead.emailBouncedAt || null,
      unsubscribed: String(lead.channelConsent?.email?.status || '').toLowerCase() === 'opted_out',
    };
  });
}

function applySentActivityFilter(rows, filter) {
  if (filter === 'never_sent') return rows.filter((r) => r.sentCount === 0);
  if (filter === 'sent_before') return rows.filter((r) => r.sentCount > 0);
  return rows;
}

async function getEmailHubAudience(clientId, { page = 1, limit = 40, search = '', filter = 'all' } = {}) {
  await reconcileStuckHubEnvelopes(clientId).catch(() => {});
  const take = Math.min(100, Math.max(1, Number(limit) || 40));
  const skip = (Math.max(1, Number(page)) - 1) * take;
  const sentActivityFilter = filter === 'never_sent' || filter === 'sent_before';
  const statusFilter = sentActivityFilter ? 'all' : filter;

  const leadFilter = buildAudienceLeadFilter(clientId, { search, filter: statusFilter });

  const [totalWithEmail, bouncedEmails, unsubscribedEmails, validEmails] = await Promise.all([
    countDistinctAudienceEmails(clientId),
    countDistinctAudienceEmails(clientId, { emailBounced: true }),
    countDistinctAudienceEmails(clientId, { 'channelConsent.email.status': 'opted_out' }),
    countDistinctAudienceEmails(clientId, {
      emailBounced: { $ne: true },
      'channelConsent.email.status': { $ne: 'opted_out' },
    }),
  ]);

  const allLeads = await AdLead.find(leadFilter).sort({ updatedAt: -1 }).limit(5000).lean();
  const enriched = dedupeAudienceRowsByEmail(await mapLeadsToAudienceRows(clientId, allLeads));
  const filtered = sentActivityFilter ? applySentActivityFilter(enriched, filter) : enriched;
  const filteredTotal = filtered.length;
  const rows = filtered.slice(skip, skip + take);

  return {
    rows,
    pagination: {
      page: Number(page),
      limit: take,
      total: filteredTotal,
      pages: Math.ceil(filteredTotal / take) || 1,
    },
    totalWithEmail,
    listHealth: {
      totalWithEmail,
      validEmails,
      bouncedEmails,
      unsubscribedEmails,
    },
  };
}

async function getEmailHubAnalytics(clientId, { period = '30d' } = {}) {
  await reconcileStuckHubEnvelopes(clientId).catch(() => {});
  const days = period === '7d' ? 7 : 30;
  const since = daysAgo(days);

  const EmailTracking = require('../models/EmailTracking');

  const [envelopeStats, trackingStats, byDayRows, templateRows, topUrls, listHealth] = await Promise.all([
    MessageEnvelope.aggregate([
      { $match: { clientId, channel: 'email', createdAt: { $gte: since } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Promise.all([
      EmailTracking.countDocuments({ clientId, type: 'open', timestamp: { $gte: since } }),
      EmailTracking.countDocuments({ clientId, type: 'click', timestamp: { $gte: since } }),
      EmailTracking.countDocuments({ clientId, type: 'unsubscribe', timestamp: { $gte: since } }),
      MessageEnvelope.countDocuments({
        clientId,
        channel: 'email',
        'tracking.bounced': true,
        createdAt: { $gte: since },
      }),
    ]),
    MessageEnvelope.aggregate([
      { $match: { clientId, channel: 'email', createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
          opened: { $sum: { $cond: [{ $gt: ['$tracking.openCount', 0] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $gt: ['$tracking.clickCount', 0] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    MessageEnvelope.aggregate([
      {
        $match: {
          clientId,
          channel: 'email',
          status: 'sent',
          createdAt: { $gte: since },
          $or: [
            { 'context.templateId': { $exists: true, $ne: '' } },
            { 'context.templateName': { $exists: true, $ne: '' } },
          ],
        },
      },
      {
        $group: {
          _id: {
            templateId: { $ifNull: ['$context.templateId', ''] },
            templateName: { $ifNull: ['$context.templateName', ''] },
          },
          sent: { $sum: 1 },
          opened: { $sum: { $cond: [{ $gt: ['$tracking.openCount', 0] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $gt: ['$tracking.clickCount', 0] }, 1, 0] } },
          name: { $first: '$context.templateName' },
        },
      },
      { $sort: { sent: -1 } },
      { $limit: 10 },
    ]),
    EmailTracking.aggregate([
      { $match: { clientId, type: 'click', timestamp: { $gte: since }, url: { $ne: '' } } },
      { $group: { _id: '$url', clicks: { $sum: 1 } } },
      { $sort: { clicks: -1 } },
      { $limit: 10 },
    ]),
    Promise.all([
      AdLead.countDocuments({ clientId, email: validEmailQuery() }),
      AdLead.countDocuments({
        clientId,
        email: validEmailQuery(),
        emailBounced: { $ne: true },
        'channelConsent.email.status': { $ne: 'opted_out' },
      }),
      AdLead.countDocuments({ clientId, email: validEmailQuery(), emailBounced: true }),
      AdLead.countDocuments({
        clientId,
        email: validEmailQuery(),
        'channelConsent.email.status': 'opted_out',
      }),
    ]),
  ]);

  const statusMap = envelopeStats.reduce((acc, r) => ({ ...acc, [r._id]: r.count }), {});
  const sent = statusMap.sent || 0;
  const delivered = sent;
  const failed = statusMap.failed || 0;
  const [openedEvents, clickedEvents, unsubscribedEvents, bouncedEvents] = trackingStats;

  const opened = await MessageEnvelope.countDocuments({
    clientId,
    channel: 'email',
    status: 'sent',
    createdAt: { $gte: since },
    'tracking.openCount': { $gt: 0 },
  });

  const clicked = await MessageEnvelope.countDocuments({
    clientId,
    channel: 'email',
    status: 'sent',
    createdAt: { $gte: since },
    'tracking.clickCount': { $gt: 0 },
  });

  const byDayMap = new Map(byDayRows.map((r) => [r._id, r]));
  const byDay = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = daysAgo(i);
    const key = d.toISOString().slice(0, 10);
    const row = byDayMap.get(key) || { sent: 0, opened: 0, clicked: 0 };
    byDay.push({ date: key, sent: row.sent || 0, opened: row.opened || 0, clicked: row.clicked || 0 });
  }

  const byTemplateMap = new Map();
  for (const r of templateRows) {
    const tid = String(r._id?.templateId || '').trim();
    const tname = String(r._id?.templateName || r.name || '').trim();
    const key = tid || `name:${tname}`;
    if (!key) continue;
    const prev = byTemplateMap.get(key);
    const sent = (prev?.sent || 0) + (r.sent || 0);
    const opened = (prev?.opened || 0) + (r.opened || 0);
    const clicked = (prev?.clicked || 0) + (r.clicked || 0);
    byTemplateMap.set(key, {
      templateId: tid || key,
      name: tname || prev?.name || 'Template',
      sent,
      opened,
      clicked,
    });
  }
  const byTemplate = [...byTemplateMap.values()]
    .map((row) => ({
      templateId: row.templateId,
      name: row.name,
      sent: row.sent,
      openRate: row.sent ? Math.round(((row.opened || 0) / row.sent) * 1000) / 10 : 0,
      ctr: row.sent ? Math.round(((row.clicked || 0) / row.sent) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.sent - a.sent)
    .slice(0, 10);

  const [totalWithEmail, validEmails, bouncedEmails, unsubscribedEmails] = listHealth;

  return {
    period: `${days}d`,
    hasSendData: sent > 0,
    totals: {
      sent,
      opened,
      clicked,
      bounced: bouncedEvents,
      unsubscribed: unsubscribedEvents,
      failed,
    },
    rates: {
      openRate: sent ? Math.round((opened / sent) * 1000) / 10 : null,
      ctr: sent ? Math.round((clicked / sent) * 1000) / 10 : null,
      bounceRate: sent ? Math.round((bouncedEvents / sent) * 1000) / 10 : null,
      unsubscribeRate: sent ? Math.round((unsubscribedEvents / sent) * 1000) / 10 : null,
    },
    byDay,
    byTemplate,
    topClickedUrls: topUrls.map((r) => ({ url: r._id, clicks: r.clicks })),
    listHealth: {
      totalWithEmail,
      validEmails,
      bouncedEmails,
      unsubscribedEmails,
    },
  };
}

async function getEmailHubTemplateStats(clientId) {
  await reconcileStuckHubEnvelopes(clientId).catch(() => {});
  const since = daysAgo(365);
  const rows = await MessageEnvelope.aggregate([
    {
      $match: {
        clientId,
        channel: 'email',
        status: 'sent',
        createdAt: { $gte: since },
        $or: [
          { 'context.templateId': { $exists: true, $ne: '' } },
          { 'context.templateName': { $exists: true, $ne: '' } },
        ],
      },
    },
    {
      $group: {
        _id: {
          templateId: { $ifNull: ['$context.templateId', ''] },
          templateName: { $ifNull: ['$context.templateName', ''] },
        },
        sentCount: { $sum: 1 },
        lastSentAt: { $max: '$sentAt' },
        templateName: { $first: '$context.templateName' },
      },
    },
  ]);

  const stats = {};
  const mergeStat = (key, patch) => {
    if (!key) return;
    const prev = stats[key];
    if (!prev) {
      stats[key] = patch;
      return;
    }
    const lastA = prev.lastSentAt ? new Date(prev.lastSentAt).getTime() : 0;
    const lastB = patch.lastSentAt ? new Date(patch.lastSentAt).getTime() : 0;
    stats[key] = {
      sentCount: Math.max(prev.sentCount || 0, patch.sentCount || 0),
      lastSentAt: lastB > lastA ? patch.lastSentAt : prev.lastSentAt,
      templateName: patch.templateName || prev.templateName,
    };
  };

  for (const row of rows) {
    const tid = String(row._id?.templateId || '').trim();
    const tname = String(row._id?.templateName || row.templateName || '').trim();
    const patch = {
      sentCount: row.sentCount || 0,
      lastSentAt: row.lastSentAt || null,
      templateName: tname,
    };
    if (tid) mergeStat(tid, patch);
    if (tname) mergeStat(`name:${tname}`, patch);
  }
  return { stats };
}

function escapeCsvCell(val) {
  const s = String(val ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function exportEmailHubAudienceCsv(clientId, { filter = 'valid', search = '' } = {}) {
  const exportFilter = filter === 'all' ? 'valid' : filter;
  const leadFilter = buildAudienceLeadFilter(clientId, { search, filter: exportFilter });

  const leads = await AdLead.find(leadFilter)
    .select('name email phoneNumber emailBounced channelConsent')
    .sort({ updatedAt: -1 })
    .limit(10000)
    .lean();

  const rows = dedupeAudienceRowsByEmail(await mapLeadsToAudienceRows(clientId, leads));
  const phoneByLeadId = new Map(leads.map((l) => [String(l._id), l.phoneNumber || '']));

  const lines = ['name,email,phone'];
  for (const row of rows) {
    lines.push(
      [
        escapeCsvCell(row.name === '—' ? '' : row.name),
        escapeCsvCell(row.email || ''),
        escapeCsvCell(phoneByLeadId.get(row.leadId) || ''),
      ].join(',')
    );
  }

  return {
    csv: `${lines.join('\n')}\n`,
    count: rows.length,
    filter: exportFilter,
  };
}

async function sendEmailHubOne(clientId, body = {}, actorUserId = null) {
  const {
    toEmail,
    toName,
    subject,
    content,
    leadId,
    format,
    scheduleAt,
    templateId,
    templateName,
    mergeContext,
  } = body;
  const email = String(toEmail || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const err = new Error('A valid recipient email is required.');
    err.status = 400;
    throw err;
  }
  if (!subject || !String(subject).trim() || !content || !String(content).trim()) {
    const err = new Error('Subject and message content are required.');
    err.status = 400;
    throw err;
  }

  const client = await Client.findOne({ clientId });
  if (!client) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }
  if (!isWorkspaceEmailReady(client)) {
    const err = new Error('Connect Gmail in Settings before sending email.');
    err.status = 400;
    throw err;
  }

  let lead = null;
  if (leadId && mongoose.Types.ObjectId.isValid(String(leadId))) {
    lead = await AdLead.findOne({ clientId, _id: leadId }).lean();
  }
  if (!lead) {
    lead = await AdLead.findOne({ clientId, email }).lean();
  }

  const mergeLead = lead || {
    name: String(toName || '').trim() || 'Customer',
    email,
    phoneNumber: '',
    cartSnapshot: null,
    abandonedCheckoutUrl: null,
  };

  await assertLeadCanReceiveMarketingEmail(clientId, lead, email);

  const flatContext =
    mergeContext && typeof mergeContext === 'object' && !Array.isArray(mergeContext) ? mergeContext : {};

  let mergeSubject = subject;
  let mergeContent = content;
  if (body.testMode === true) {
    const {
      buildOrderEmailTestSampleContext,
      applyMergeContext,
    } = require('../utils/core/orderEmailMergeFields');
    const sampleCtx = {
      ...buildOrderEmailTestSampleContext(client, email),
      ...flatContext,
    };
    const premerged = applyMergeContext(subject, content, sampleCtx);
    mergeSubject = premerged.subject;
    mergeContent = premerged.html;
  }

  const merged = mergeEmailForLead(mergeSubject, mergeContent, mergeLead, client, flatContext);
  if (merged.unknownTokens.length) {
    const err = new Error(`Unsupported merge fields: ${merged.unknownTokens.join(', ')}`);
    err.status = 400;
    err.unknownTokens = merged.unknownTokens;
    err.supportedTokens = KNOWN_EMAIL_TOKEN_KEYS;
    throw err;
  }

  const sendFormat = format === 'plain' || format === 'text' ? 'plain' : 'html';
  const plainBody = htmlToPlainText(merged.html);

  const ctx = {
    source: 'routes/email-hub:send',
    actorUserId,
    recipientEmail: email,
    subject: merged.subject,
    format: sendFormat,
    ...(templateId ? { templateId: String(templateId), templateName: templateName || merged.subject } : {}),
  };

  const scheduleDate = scheduleAt ? new Date(scheduleAt) : null;
  if (scheduleDate && !Number.isNaN(scheduleDate.getTime()) && scheduleDate.getTime() > Date.now() + 30_000) {
    const scheduledMsg = await ScheduledMessage.create({
      clientId,
      phone: email,
      channel: 'email',
      intent: 'marketing',
      messageType: 'text',
      content: {
        subject: merged.subject,
        body: sendFormat === 'plain' ? plainBody : merged.html,
        toEmail: email,
        format: sendFormat,
        source: 'routes/email-hub:send',
        ...(templateId ? { templateId: String(templateId) } : {}),
      },
      sendAt: scheduleDate,
      timezone: body.timezone || 'Asia/Kolkata',
      status: 'pending',
      sourceType: 'follow_up',
      sourceId: String(actorUserId || lead?._id || `email-hub-${Date.now()}`),
    });

    try {
      await MessageEnvelope.create({
        clientId,
        channel: 'email',
        intent: 'marketing',
        status: 'queued',
        idempotencyKey: hubEnvelopeIdempotencyKey(clientId, email, merged.subject, String(scheduledMsg._id)),
        context: { ...ctx, scheduledMessageId: String(scheduledMsg._id), sendAt: scheduleDate },
        templateName: merged.subject,
        contactId: lead?._id || undefined,
      });
    } catch (_) { /* non-fatal */ }

    return {
      success: true,
      status: 'scheduled',
      scheduledAt: scheduleDate.toISOString(),
      message: `Email scheduled for ${scheduleDate.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.`,
    };
  }

  const sendOut = await dispatchTrackedEmail({
    client,
    clientId,
    to: email,
    subject: merged.subject,
    html: merged.html,
    text: plainBody,
    format: sendFormat,
    intent: 'marketing',
    contactId: lead?._id || null,
    context: ctx,
    idempotencyKey: hubEnvelopeIdempotencyKey(clientId, email, merged.subject),
    templateName: merged.subject,
  });

  if (templateId) {
    await bumpTemplateSentStats(clientId, templateId);
  }

  return { success: true, status: 'sent', message: `Email sent to ${email}.`, envelopeId: sendOut.envelopeId };
}

async function sendEmailHubBulk(clientId, body = {}, actorUserId = null) {
  const { leadIds, subject, content, format, scheduleAt, templateId, templateName } = body;

  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    const err = new Error('Select at least one contact with an email address.');
    err.status = 400;
    throw err;
  }
  if (!subject || !String(subject).trim() || !content || !String(content).trim()) {
    const err = new Error('Subject and message content are required.');
    err.status = 400;
    throw err;
  }

  const client = await Client.findOne({ clientId });
  if (!client) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }
  if (!isWorkspaceEmailReady(client)) {
    const err = new Error('Connect Gmail before sending email.');
    err.status = 400;
    throw err;
  }

  const sendableCount = leadIds.length;
  const rateCheck = await checkEmailDailyLimit(clientId, sendableCount);
  if (!rateCheck.allowed) {
    const err = new Error(
      `Daily limit: ${rateCheck.sent || 0}/${rateCheck.limit} sent today. ${rateCheck.remaining} remaining — reduce batch size.`
    );
    err.code = 'daily_limit_reached';
    err.status = 429;
    throw err;
  }

  const oids = leadIds
    .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));

  const leads = await AdLead.find({ clientId, _id: { $in: oids } }).lean();

  const probeLead = {
    name: 'Jane Doe',
    email: 'jane@example.com',
    phoneNumber: '+919999999999',
    cartSnapshot: { items: [{ title: 'Sample', quantity: 1, price: '99', image: '' }] },
  };
  const probe = mergeEmailForLead(subject, content, probeLead, client);
  if (probe.unknownTokens.length) {
    const err = new Error(`Unsupported merge fields: ${probe.unknownTokens.join(', ')}`);
    err.status = 400;
    err.unknownTokens = probe.unknownTokens;
    err.supportedTokens = KNOWN_EMAIL_TOKEN_KEYS;
    throw err;
  }

  const sendFormat = format === 'plain' || format === 'text' ? 'plain' : 'html';
  const scheduleDate = scheduleAt ? new Date(scheduleAt) : null;
  const isScheduled =
    scheduleDate && !Number.isNaN(scheduleDate.getTime()) && scheduleDate.getTime() > Date.now() + 30_000;

  const sent = [];
  const skipped = [];
  const failed = [];
  const scheduled = [];
  const bulkJobId = newBulkJobId();
  const total = leadIds.length;
  let processed = 0;
  let authRevoked = false;

  const pushBulkProgress = (extra = {}) => {
    const sentCount = sent.length;
    const failedCount = failed.length;
    const skippedCount = skipped.length;
    emitEmailBulkProgress(clientId, {
      bulkJobId,
      status: extra.status || 'processing',
      sent: sentCount,
      failed: failedCount,
      skipped: skippedCount,
      scheduled: scheduled.length,
      total,
      processed,
      percent: total ? Math.min(100, Math.round((processed / total) * 100)) : 0,
      current: extra.current || null,
    });
  };

  const foundIds = new Set(leads.map((l) => String(l._id)));
  for (const id of leadIds) {
    const sid = String(id);
    if (!mongoose.Types.ObjectId.isValid(sid) || !foundIds.has(sid)) {
      skipped.push({ leadId: sid, reason: 'lead_not_found' });
      processed += 1;
    }
  }

  pushBulkProgress({ status: 'started', current: null });

  for (const lead of leads) {
    const email = String(lead.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      skipped.push({ leadId: String(lead._id), reason: 'no_email' });
      processed += 1;
      pushBulkProgress({ current: email || lead.email || null });
      continue;
    }

    const consent = checkConsent({ contact: lead, channel: 'email', intent: 'marketing' });
    if (!consent.pass) {
      skipped.push({ leadId: String(lead._id), reason: consent.reason || 'email_opted_out' });
      processed += 1;
      pushBulkProgress({ current: email });
      continue;
    }
    const suppress = await checkSuppression({ clientId, channel: 'email', contact: lead });
    if (!suppress.pass) {
      skipped.push({ leadId: String(lead._id), reason: suppress.reason || 'suppressed' });
      processed += 1;
      pushBulkProgress({ current: email });
      continue;
    }

    const merged = mergeEmailForLead(subject, content, lead, client);
    const plainBody = htmlToPlainText(merged.html);
    const ctx = {
      source: 'routes/email-hub:bulk-send',
      actorUserId,
      recipientEmail: email,
      subject: merged.subject,
      format: sendFormat,
      ...(templateId ? { templateId: String(templateId), templateName: templateName || merged.subject } : {}),
    };

    if (isScheduled) {
      try {
        const scheduledMsg = await ScheduledMessage.create({
          clientId,
          phone: email,
          channel: 'email',
          intent: 'marketing',
          messageType: 'text',
          content: {
            subject: merged.subject,
            body: sendFormat === 'plain' ? plainBody : merged.html,
            toEmail: email,
            format: sendFormat,
            source: 'routes/email-hub:send',
            templateId: templateId ? String(templateId) : undefined,
          },
          sendAt: scheduleDate,
          timezone: body.timezone || 'Asia/Kolkata',
          status: 'pending',
          sourceType: 'follow_up',
          sourceId: String(actorUserId || lead._id || `email-hub-bulk-${Date.now()}`),
        });
        scheduled.push(String(lead._id));
        try {
          await MessageEnvelope.create({
            clientId,
            channel: 'email',
            intent: 'marketing',
            status: 'queued',
            idempotencyKey: hubEnvelopeIdempotencyKey(clientId, email, merged.subject, String(scheduledMsg._id)),
            context: { ...ctx, scheduledMessageId: String(scheduledMsg._id), sendAt: scheduleDate },
            templateName: merged.subject,
            contactId: lead._id,
          });
        } catch (_) { /* non-fatal */ }
      } catch (e) {
        failed.push({ leadId: String(lead._id), reason: e.message || 'schedule_failed' });
      }
      processed += 1;
      pushBulkProgress({ current: email });
      continue;
    }

    try {
      const sendOut = await dispatchTrackedEmail({
        client,
        clientId,
        to: email,
        subject: merged.subject,
        html: merged.html,
        text: plainBody,
        format: sendFormat,
        intent: 'marketing',
        contactId: lead._id,
        context: ctx,
        idempotencyKey: hubEnvelopeIdempotencyKey(clientId, email, merged.subject, String(lead._id)),
        templateName: merged.subject,
        skipRateLimit: true,
      });

      if (sendOut.success) {
        sent.push(String(lead._id));
      } else {
        failed.push({ leadId: String(lead._id), reason: 'send_failed' });
      }
    } catch (sendErr) {
      failed.push({
        leadId: String(lead._id),
        reason: sendErr.message || 'send_failed',
        code: sendErr.code,
      });
      if (sendErr.code === 'gmail_auth_revoked') {
        authRevoked = true;
        break;
      }
    }

    if (templateId) {
      await bumpTemplateSentStats(clientId, templateId);
    }

    processed += 1;
    pushBulkProgress({ current: email });
    await sleep(350);
  }

  if (sent.length > 0) {
    await incrementEmailCount(clientId, sent.length);
  }

  const status = isScheduled ? 'scheduled' : 'sent';
  const message = isScheduled
    ? `Scheduled ${scheduled.length} email(s) for ${scheduleDate.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}.`
    : sent.length
      ? `Sent ${sent.length} of ${leadIds.length} email(s).`
      : `No emails sent — ${failed.length} failed, ${skipped.length} skipped.`;

  const result = {
    success: sent.length > 0 || scheduled.length > 0,
    status,
    bulkJobId,
    sent,
    scheduled,
    skipped,
    failed,
    message,
  };

  emitEmailBulkCompleted(clientId, {
    bulkJobId,
    status: 'completed',
    sent: sent.length,
    failed: failed.length,
    skipped: skipped.length,
    scheduled: scheduled.length,
    total,
    processed,
    percent: 100,
    message,
  });

  if (authRevoked && sent.length === 0 && scheduled.length === 0) {
    const { GMAIL_RECONNECT_MESSAGE } = require('../utils/core/emailService');
    const err = new Error(GMAIL_RECONNECT_MESSAGE);
    err.status = 401;
    err.code = 'gmail_auth_revoked';
    throw err;
  }

  return result;
}

module.exports = {
  getEmailHubSummary,
  getEmailHubLogs,
  getEmailHubSequenceMails,
  getEmailHubAudience,
  exportEmailHubAudienceCsv,
  getEmailHubTemplateStats,
  getEmailHubAnalytics,
  sendEmailHubOne,
  sendEmailHubBulk,
  labelSource,
  formatEmailLogSource,
};
