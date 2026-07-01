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
  isStepSkipped,
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

function normalizePhoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length >= 10) return d.slice(-10);
  return '';
}

function resolveRecipientName(seq = {}, lead = {}, journeyName = '') {
  const leadName = String(lead?.name || lead?.fullName || '').trim();
  const seqName = String(seq.name || '').trim();
  const blueprintName = String(
    journeyName || seq.enrollment?.blueprint?.name || ''
  ).trim();

  if (leadName) return leadName;
  if (
    seqName
    && blueprintName
    && seqName.toLowerCase() === blueprintName.toLowerCase()
  ) {
    return 'Customer';
  }
  if (seqName) return seqName;
  return 'Customer';
}

async function fetchLeadsForSequences(clientId, sequences = []) {
  const leadIds = [...new Set(sequences.map((s) => String(s.leadId)).filter(Boolean))];
  const phoneKeys = [
    ...new Set(
      sequences
        .map((s) => normalizePhoneKey(s.phone))
        .filter(Boolean)
    ),
  ];

  const queries = [];
  if (leadIds.length) {
    queries.push(
      AdLead.find({ clientId, _id: { $in: leadIds } })
        .select('name fullName phoneNumber phone email')
        .lean()
    );
  }
  if (phoneKeys.length) {
    queries.push(
      AdLead.find({
        clientId,
        $or: phoneKeys.map((k) => ({ phoneNumber: { $regex: `${k}$` } })),
      })
        .select('name fullName phoneNumber phone email')
        .lean()
    );
  }
  if (!queries.length) {
    return { byId: new Map(), byPhone: new Map() };
  }

  const resultSets = await Promise.all(queries);
  const allLeads = [];
  const seen = new Set();
  for (const rows of resultSets) {
    for (const lead of rows) {
      const id = String(lead._id);
      if (seen.has(id)) continue;
      seen.add(id);
      allLeads.push(lead);
    }
  }

  const byId = new Map(allLeads.map((l) => [String(l._id), l]));
  const byPhone = new Map();
  for (const lead of allLeads) {
    const key = normalizePhoneKey(lead.phoneNumber || lead.phone);
    if (key && !byPhone.has(key)) byPhone.set(key, lead);
  }
  return { byId, byPhone };
}

function resolveLeadForSequence(seq, leadLookups = {}) {
  const byId = leadLookups.byId || new Map();
  const byPhone = leadLookups.byPhone || new Map();
  return (
    byId.get(String(seq.leadId))
    || byPhone.get(normalizePhoneKey(seq.phone))
    || null
  );
}

function formatJourneyStepLabel(step = {}) {
  const channel = step.type || step.channel || 'whatsapp';
  if (channel === 'email') {
    const name = String(step.templateName || '').trim();
    if (name) return name.replace(/_/g, ' ');
    const subject = String(step.subject || '').trim();
    if (subject) return subject;
    return 'Email';
  }
  return (step.templateName || 'WhatsApp').replace(/_/g, ' ');
}

function buildStepOutcomes(steps = []) {
  return (steps || []).map((step) => {
    const channel = step.type || step.channel || 'whatsapp';
    const isEmail = channel === 'email';
    return {
      stepIndex: step.stepIndex,
      channel,
      label: formatJourneyStepLabel(step),
      outcome: step.outcome || 'pending',
      reason: step.failureReason || null,
      sentAt: step.sentAt || null,
      readAt: step.readAt || null,
    };
  });
}

function buildSkipSummary(steps = []) {
  const reasons = new Set();
  for (const step of steps) {
    if (step.outcome !== 'skipped' && step.outcome !== 'failed') continue;
    const code = step.failureReason || step.outcome;
    if (code) reasons.add(code);
  }
  return [...reasons];
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
  else if (skipped > 0 && sent === 0 && failed === 0) bestOutcome = 'skipped';
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
    skipped: Number(stats.skipped || 0),
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

function mapRecipientRow(seq, lead, orders = [], journeyName = '') {
  const engagement = summarizeRecipientEngagement(seq.steps || [], orders);
  const phoneRaw = seq.phone || lead?.phoneNumber || lead?.phone || '';
  const displayName = resolveRecipientName(seq, lead, journeyName);
  return {
    enrollmentId: String(seq._id),
    leadId: seq.leadId ? String(seq.leadId) : '',
    phone: maskPhone(phoneRaw),
    phoneRaw,
    phoneDisplay: phoneRaw,
    name: displayName,
    email: maskEmail(seq.email || lead?.email),
    emailRaw: seq.email || lead?.email || '',
    status: seq.status || 'active',
    enrolledAt: seq.createdAt,
    completedAt: seq.status === 'completed' ? seq.updatedAt : null,
    cancelledAt: seq.cancelledAt || null,
    cancelledReason: seq.cancelledReason || '',
    sourceOrderId: seq.sourceOrderId || '',
    engagement,
    stepOutcomes: buildStepOutcomes(engagement.steps),
    skipSummary: buildSkipSummary(engagement.steps),
    orders,
  };
}

function groupKeyForRecipient(row = {}) {
  const phone = normalizePhoneKey(row.phoneRaw);
  if (phone) return `phone:${phone}`;
  if (row.leadId) return `lead:${row.leadId}`;
  return `enrollment:${row.enrollmentId}`;
}

function groupRecipientsByContact(recipients = []) {
  const map = new Map();
  for (const row of recipients) {
    const key = groupKeyForRecipient(row);
    if (!map.has(key)) {
      map.set(key, {
        groupKey: key,
        leadId: row.leadId || '',
        phone: row.phone,
        phoneRaw: row.phoneRaw,
        phoneDisplay: row.phoneDisplay || row.phoneRaw,
        name: row.name,
        email: row.email,
        emailRaw: row.emailRaw || '',
        runCount: 0,
        enrollments: [],
        latestEnrolledAt: null,
        rollup: {
          sent: 0,
          opened: 0,
          clicked: 0,
          failed: 0,
          skipped: 0,
          revenueInr: 0,
          bestOutcome: 'enrolled',
        },
      });
    }
    const group = map.get(key);
    group.runCount += 1;
    group.enrollments.push(row);
    if (row.name && row.name !== 'Customer') group.name = row.name;
    if (row.emailRaw) group.emailRaw = row.emailRaw;
    else if (row.email && row.email !== '—') group.email = row.email;
    const enrolledAt = row.enrolledAt ? new Date(row.enrolledAt) : null;
    if (enrolledAt && (!group.latestEnrolledAt || enrolledAt > new Date(group.latestEnrolledAt))) {
      group.latestEnrolledAt = row.enrolledAt;
    }
    const e = row.engagement || {};
    group.rollup.sent += Number(e.sent || 0);
    group.rollup.opened += Number(e.opened || 0);
    group.rollup.clicked += Number(e.clicked || 0);
    group.rollup.failed += Number(e.failed || 0);
    group.rollup.skipped += Number(e.skipped || 0);
    group.rollup.revenueInr += Number(e.revenueInr || 0);
    const outcomeRank = {
      purchased: 6,
      clicked: 5,
      opened: 4,
      sent: 3,
      partial: 2,
      failed: 1,
      skipped: 1,
      enrolled: 0,
    };
    const cur = outcomeRank[group.rollup.bestOutcome] ?? 0;
    const next = outcomeRank[e.bestOutcome] ?? 0;
    if (next > cur) group.rollup.bestOutcome = e.bestOutcome;
  }

  return [...map.values()]
    .map((g) => {
      const latest = g.enrollments[0] || null;
      const latestSteps = latest?.stepOutcomes || buildStepOutcomes(latest?.engagement?.steps);
      const resolvedName = g.enrollments.find((r) => r.name && r.name !== 'Customer')?.name || g.name;
      return {
        ...g,
        name: resolvedName || g.name || 'Customer',
        stepOutcomes: latestSteps,
        skipSummary: latest?.skipSummary || buildSkipSummary(latest?.engagement?.steps),
        enrollments: g.enrollments.sort(
          (a, b) => new Date(b.enrolledAt || 0) - new Date(a.enrolledAt || 0)
        ),
      };
    })
    .sort((a, b) => new Date(b.latestEnrolledAt || 0) - new Date(a.latestEnrolledAt || 0));
}

async function getJourneyAnalyticsDetail(clientId, sourceFlowId, options = {}) {
  const period = options.period || '7d';
  const page = Math.max(1, Number(options.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 25));
  const search = String(options.search || '').trim().toLowerCase();
  const journeyName = String(options.journeyName || '').trim();
  const { from, to, label } = parsePeriod(period);
  const MAX_FETCH = 5000;

  const enrollMatch = {
    clientId,
    sourceFlowId,
    ...((from && { createdAt: { $gte: from, $lte: to } }) || {}),
  };

  const [stats, funnel, sequences] = await Promise.all([
    getBlueprintStats(clientId, sourceFlowId, period),
    getStepFunnel(clientId, sourceFlowId, period),
    FollowUpSequence.find(enrollMatch)
      .sort({ createdAt: -1 })
      .limit(MAX_FETCH)
      .lean(),
  ]);

  const leadLookups = await fetchLeadsForSequences(clientId, sequences);

  const attrMap = await fetchAttributionBySequence(
    clientId,
    sourceFlowId,
    sequences.map((s) => s._id)
  );

  let allRecipients = sequences.map((seq) => {
    const lead = resolveLeadForSequence(seq, leadLookups);
    const orders = attrMap.get(String(seq._id)) || [];
    return mapRecipientRow(seq, lead, orders, journeyName);
  });

  if (search) {
    allRecipients = allRecipients.filter((r) => {
      const hay = [
        r.name,
        r.phoneRaw,
        r.phoneDisplay,
        r.emailRaw,
        r.email,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(search);
    });
  }

  const allGroups = groupRecipientsByContact(allRecipients);
  const totalEnrollments = allRecipients.length;
  const totalContacts = allGroups.length;
  const paginatedGroups = allGroups.slice((page - 1) * limit, page * limit);
  const recipients = paginatedGroups.flatMap((g) => g.enrollments);

  return {
    sourceFlowId,
    period: { from, to, label },
    summary: buildSummaryFromStats(stats),
    funnel: funnel.steps || [],
    funnelByNodeId: funnel.byNodeId || {},
    recipients,
    recipientGroups: paginatedGroups,
    pagination: {
      page,
      limit,
      total: totalContacts,
      totalEnrollments,
      uniqueContacts: totalContacts,
      totalPages: Math.ceil(totalContacts / limit) || 1,
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
  groupRecipientsByContact,
  groupKeyForRecipient,
  getJourneyAnalyticsDetail,
  exportJourneyEnrollmentsCsv,
};
