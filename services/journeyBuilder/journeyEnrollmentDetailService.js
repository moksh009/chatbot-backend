'use strict';

const FollowUpSequence = require('../../models/FollowUpSequence');
const JourneyRevenueAttribution = require('../../models/JourneyRevenueAttribution');
const AdLead = require('../../models/AdLead');
const {
  getBlueprintStats,
  getStepFunnel,
  parsePeriod,
  MIN_SAMPLE_SIZE,
  isStepSent,
  isStepFailed,
} = require('./journeyStatsService');

const TRACKING_NOTE =
  'WhatsApp "Read" uses Meta read receipts — recipients control this in their WhatsApp privacy settings; ' +
  '0% read does not mean broken tracking. ' +
  'Email "Opened" uses a tracking pixel; Apple Mail Privacy Protection pre-fetches pixels before the ' +
  'recipient reads, inflating open rates for ~59% of Apple Mail users (2026). ' +
  'Treat email click rate (not open rate) as the reliable engagement signal. ' +
  'WhatsApp URL button clicks require a dynamic URL button template — static URL buttons cannot be tracked (Meta platform limitation). ' +
  'Revenue is last-touch within 30 days for cart recovery and marketing journeys. ' +
  'Order confirmation journeys do not receive revenue attribution.';

function maskPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 4) return '—';
  return `••••${d.slice(-4)}`;
}

function maskEmail(email) {
  const s = String(email || '').trim();
  if (!s || !s.includes('@')) return '—';
  const [user, domain] = s.split('@');
  if (!user || !domain) return '—';
  const head = user.length <= 2 ? user[0] || '*' : `${user.slice(0, 2)}••`;
  return `${head}@${domain}`;
}

function safeRate(num, den) {
  if (!den || den <= 0) return 0;
  return num / den;
}

function mapStepEngagement(step = {}, stepIndex = 0) {
  // step.type is always set correctly by compileGraphToSteps.
  // step.channel defaulted to 'whatsapp' in the old schema even for email steps,
  // so prefer step.type to avoid showing email steps as WhatsApp.
  const channel = step.type || step.channel || 'whatsapp';
  let outcome = 'pending';
  if (step.status === 'failed') outcome = 'failed';
  else if (step.status === 'skipped') outcome = 'skipped';
  else if (step.status === 'cancelled') outcome = 'cancelled';
  else if (step.clickedAt) outcome = 'clicked';
  else if (step.readAt) outcome = 'read';
  else if (step.deliveredAt) outcome = 'delivered';
  else if (step.status === 'sent' || step.sentAt) outcome = 'sent';

  return {
    stepIndex,
    graphNodeId: step.graphNodeId || '',
    channel,
    type: step.type || channel,
    templateName: step.templateName || '',
    subject: step.subject || '',
    status: step.status || 'pending',
    sentAt: step.sentAt || null,
    deliveredAt: step.deliveredAt || null,
    readAt: step.readAt || null,
    clickedAt: step.clickedAt || null,
    failedAt: step.failedAt || null,
    failureReason: step.failureReason || step.skipReason || null,
    clickType: step.clickType || null,
    outcome,
  };
}

function summarizeRecipientEngagement(steps = [], orders = []) {
  const mapped = (steps || []).map((s, i) => mapStepEngagement(s, i));

  // Use shared helpers from journeyStatsService — single source of truth
  const sent = mapped.filter((s) => isStepSent(s)).length;
  const opened = mapped.filter((s) => !!s.readAt).length;
  const clicked = mapped.filter((s) => !!s.clickedAt).length;
  const failed = mapped.filter((s) => isStepFailed(s) || s.outcome === 'failed').length;
  const skipped = mapped.filter((s) => s.outcome === 'skipped').length;
  const revenueInr = orders.reduce((sum, o) => sum + Number(o.amount || 0), 0);

  // bestOutcome: failed takes priority so enrollment clearly shows as failed if any step did
  let bestOutcome = 'enrolled';
  if (orders.length) bestOutcome = 'purchased';
  else if (clicked > 0) bestOutcome = 'clicked';
  else if (opened > 0) bestOutcome = 'opened';
  else if (sent > 0 && failed === 0) bestOutcome = 'sent';
  else if (failed > 0 && sent === 0) bestOutcome = 'failed';
  else if (sent > 0) bestOutcome = 'partial'; // some sent, some failed

  return {
    sent,
    opened,
    clicked,
    failed,
    skipped,
    revenueInr,
    attributedOrders: orders.length,
    bestOutcome,
    steps: mapped,
  };
}

function buildSummaryFromStats(stats = {}) {
  const sent = Number(stats.sent || 0);
  const delivered = Number(stats.delivered || 0);
  const read = Number(stats.read || 0);
  const clicked = Number(stats.clicked || 0);
  const uniqueRecipients = Number(stats.uniqueRecipients || 0);
  const attributedOrders = Number(stats.attributedOrders || 0);

  return {
    uniqueRecipients,
    sent,
    delivered,
    read,
    clicked,
    failed: Number(stats.failed || 0),
    revenueInr: Number(stats.revenueInr || 0),
    attributedOrders,
    openRate: stats.openRate ?? safeRate(read, delivered || sent),
    clickRate: stats.clickRate ?? safeRate(clicked, delivered || sent),
    orderRate: stats.orderRate ?? safeRate(attributedOrders, uniqueRecipients),
    lowVolume: stats.lowVolume ?? sent < MIN_SAMPLE_SIZE,
    openRateUnavailable: stats.openRateUnavailable ?? false,
  };
}

async function fetchAttributionBySequence(clientId, sourceFlowId, sequenceIds = []) {
  const ids = [...new Set(sequenceIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  const rows = await JourneyRevenueAttribution.find({
    clientId,
    sourceFlowId,
    sequenceId: { $in: ids },
  })
    .select('sequenceId orderKey shopifyOrderId amount currency attributedAt channel')
    .sort({ attributedAt: -1 })
    .lean();

  const map = new Map();
  for (const row of rows) {
    const key = String(row.sequenceId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      orderKey: row.orderKey,
      shopifyOrderId: row.shopifyOrderId || '',
      amount: Number(row.amount || 0),
      currency: row.currency || 'INR',
      attributedAt: row.attributedAt,
      channel: row.channel || 'whatsapp',
    });
  }
  return map;
}

function mapRecipientRow(seq, lead, orders = []) {
  const engagement = summarizeRecipientEngagement(seq.steps || [], orders);
  return {
    enrollmentId: String(seq._id),
    leadId: seq.leadId ? String(seq.leadId) : '',
    phone: maskPhone(seq.phone || lead?.phoneNumber || lead?.phone),
    phoneRaw: seq.phone || lead?.phoneNumber || lead?.phone || '',
    name: seq.name || lead?.name || lead?.fullName || 'Customer',
    email: maskEmail(seq.email || lead?.email),
    status: seq.status || 'active',
    enrolledAt: seq.createdAt,
    completedAt: seq.status === 'completed' ? seq.updatedAt : null,
    cancelledAt: seq.cancelledAt || null,
    cancelledReason: seq.cancelledReason || '',
    sourceOrderId: seq.sourceOrderId || '',
    engagement,
    orders,
  };
}

async function getJourneyAnalyticsDetail(clientId, sourceFlowId, options = {}) {
  const period = options.period || '7d';
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 25));
  const search = String(options.search || '').trim().toLowerCase();
  const { from, to, label } = parsePeriod(period);

  const enrollMatch = {
    clientId,
    sourceFlowId,
    ...((from && { createdAt: { $gte: from, $lte: to } }) || {}),
  };

  if (search) {
    enrollMatch.$or = [
      { phone: { $regex: search, $options: 'i' } },
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
    ];
  }

  const [stats, funnel, totalCount, sequences] = await Promise.all([
    getBlueprintStats(clientId, sourceFlowId, period),
    getStepFunnel(clientId, sourceFlowId, period),
    FollowUpSequence.countDocuments(enrollMatch),
    FollowUpSequence.find(enrollMatch)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);

  const leadIds = [...new Set(sequences.map((s) => String(s.leadId)).filter(Boolean))];
  const leads = leadIds.length
    ? await AdLead.find({ clientId, _id: { $in: leadIds } })
        .select('name fullName phoneNumber phone email')
        .lean()
    : [];
  const leadMap = new Map(leads.map((l) => [String(l._id), l]));

  const attrMap = await fetchAttributionBySequence(
    clientId,
    sourceFlowId,
    sequences.map((s) => s._id)
  );

  let recipients = sequences.map((seq) => {
    const lead = leadMap.get(String(seq.leadId));
    const orders = attrMap.get(String(seq._id)) || [];
    return mapRecipientRow(seq, lead, orders);
  });

  return {
    sourceFlowId,
    period: { from, to, label },
    summary: buildSummaryFromStats(stats),
    funnel: funnel.steps || [],
    funnelByNodeId: funnel.byNodeId || {},
    recipients,
    pagination: {
      page,
      limit,
      total: totalCount,
      totalPages: Math.ceil(totalCount / limit) || 1,
    },
    trackingNote: TRACKING_NOTE,
  };
}

function escapeCsv(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

async function exportJourneyEnrollmentsCsv(clientId, sourceFlowId, options = {}) {
  const period = options.period || 'all';
  const detail = await getJourneyAnalyticsDetail(clientId, sourceFlowId, {
    period,
    page: 1,
    limit: 5000,
    search: options.search || '',
  });

  const header = [
    'Enrollment ID',
    'Name',
    'Phone',
    'Email',
    'Status',
    'Enrolled at',
    'Best outcome',
    'Steps sent',
    'Opened',
    'Clicked',
    'Attributed orders',
    'Revenue (INR)',
    'Cancelled reason',
  ];

  const lines = [
    header.join(','),
    ...detail.recipients.map((r) => {
      const e = r.engagement || {};
      return [
        escapeCsv(r.enrollmentId),
        escapeCsv(r.name),
        escapeCsv(r.phoneRaw || r.phone),
        escapeCsv(r.email),
        escapeCsv(r.status),
        escapeCsv(r.enrolledAt ? new Date(r.enrolledAt).toISOString() : ''),
        escapeCsv(e.bestOutcome),
        escapeCsv(e.sent),
        escapeCsv(e.opened),
        escapeCsv(e.clicked),
        escapeCsv(e.attributedOrders),
        escapeCsv(e.revenueInr),
        escapeCsv(r.cancelledReason),
      ].join(',');
    }),
  ];

  return {
    csv: lines.join('\n'),
    filename: `journey_${sourceFlowId}_enrollments.csv`,
    rowCount: detail.recipients.length,
  };
}

module.exports = {
  TRACKING_NOTE,
  maskPhone,
  maskEmail,
  mapStepEngagement,
  summarizeRecipientEngagement,
  buildSummaryFromStats,
  getJourneyAnalyticsDetail,
  exportJourneyEnrollmentsCsv,
};
