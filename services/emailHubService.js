'use strict';

const MessageEnvelope = require('../models/MessageEnvelope');
const FollowUpSequence = require('../models/FollowUpSequence');
const AdLead = require('../models/AdLead');
const Client = require('../models/Client');
const { isWorkspaceEmailReady } = require('../utils/core/emailService');

const SOURCE_LABELS = {
  'workers/sequenceDispatchWorker': 'Sequence',
  'workers/campaignDispatchWorker': 'Campaign',
  'cron/abandonedCartScheduler': 'Cart recovery',
  'cron/abandonedCartScheduler:browse': 'Browse recovery',
  'cron/scheduledMessageCron': 'Scheduled',
  'routes/leads:bulk-email': 'Bulk email',
  'routes/conversations:send-email': 'Live chat',
  'product_watch_restock': 'Restock alert',
  'rtoProtectionService:ndr_rescue': 'NDR rescue',
};

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

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function getEmailHubSummary(clientId) {
  const client = await Client.findOne({ clientId }).lean();
  const since7 = daysAgo(7);
  const since30 = daysAgo(30);

  const [stats7, stats30, sequenceAgg] = await Promise.all([
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
  ]);

  const toMap = (rows) => rows.reduce((acc, r) => ({ ...acc, [r._id]: r.count }), {});

  const s7 = toMap(stats7);
  const s30 = toMap(stats30);
  const seq = toMap(sequenceAgg);

  const emailReady = client ? await isWorkspaceEmailReady(client) : false;

  return {
    connection: {
      connected: emailReady,
      gmailAddress: client?.gmailAddress || client?.emailUser || null,
      method: client?.emailMethod || null,
    },
    last7d: {
      sent: s7.sent || 0,
      failed: s7.failed || 0,
      blocked: s7.blocked || 0,
      duplicate: s7.duplicate || 0,
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
  const since = daysAgo(Math.min(Math.max(Number(days) || 30, 1), 90));
  const skip = (Math.max(1, Number(page)) - 1) * Math.min(100, Math.max(1, Number(limit)));
  const take = Math.min(100, Math.max(1, Number(limit)));

  const filter = { clientId, channel: 'email', createdAt: { $gte: since } };
  if (status && status !== 'all') filter.status = status;

  const [rows, total] = await Promise.all([
    MessageEnvelope.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(take)
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
    return {
      id: String(row._id),
      status: row.status,
      intent: row.intent,
      blockedBy: row.blockedBy,
      reason: row.reason || '',
      subject: ctx.subject || row.templateName || '—',
      recipientEmail: ctx.recipientEmail || contact?.email || '—',
      recipientName: contact?.name || '—',
      source: labelSource(src),
      sourceRaw: src,
      sequenceId: ctx.sequenceId || null,
      campaignId: ctx.campaignId || null,
      messageId: row.messageId || '',
      sentAt: row.sentAt || row.createdAt,
      failedAt: row.failedAt,
      createdAt: row.createdAt,
    };
  });

  if (source && source !== 'all') {
    mapped = mapped.filter((r) => r.source === source || r.sourceRaw === source);
  }

  return {
    rows: mapped,
    pagination: { page: Number(page), limit: take, total, pages: Math.ceil(total / take) },
  };
}

async function getEmailHubSequenceMails(clientId, { limit = 80, status } = {}) {
  const take = Math.min(150, Math.max(1, Number(limit) || 80));
  const seqs = await FollowUpSequence.find({ clientId })
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean();

  const rows = [];
  for (const seq of seqs) {
    (seq.steps || []).forEach((step, idx) => {
      if (step.type !== 'email') return;
      if (status && status !== 'all' && step.status !== status) return;
      rows.push({
        sequenceId: String(seq._id),
        sequenceName: seq.name || 'Untitled sequence',
        sequenceStatus: seq.status,
        stepIndex: idx,
        stepStatus: step.status,
        subject: step.subject || '—',
        recipientEmail: seq.email || '—',
        recipientName: seq.name || '—',
        sendAt: step.sendAt,
        sentAt: step.sentAt,
        failureReason: step.failureReason || step.errorLog || '',
        leadId: seq.leadId ? String(seq.leadId) : null,
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

module.exports = {
  getEmailHubSummary,
  getEmailHubLogs,
  getEmailHubSequenceMails,
  labelSource,
};
