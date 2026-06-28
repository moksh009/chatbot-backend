'use strict';

const FollowUpSequence = require('../../models/FollowUpSequence');
const JourneyRevenueAttribution = require('../../models/JourneyRevenueAttribution');

const MIN_SAMPLE_SIZE = 10;

function parsePeriod(period = '7d') {
  const now = new Date();
  const p = String(period || '7d').toLowerCase();
  if (p === 'all' || p === 'all-time') {
    return { from: null, to: now, label: p };
  }
  const match = p.match(/^(\d+)d$/);
  const days = match ? Number(match[1]) : 7;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return { from, to: now, label: `${days}d` };
}

function periodMatch(field = 'createdAt', from, to) {
  if (!from) return {};
  return { [field]: { $gte: from, $lte: to } };
}

function countEngagement(steps = []) {
  let sent = 0;
  let delivered = 0;
  let read = 0;
  let clicked = 0;
  let failed = 0;
  for (const step of steps) {
    if (step.status === 'sent') sent += 1;
    if (step.status === 'failed') failed += 1;
    if (step.deliveredAt) delivered += 1;
    if (step.readAt) read += 1;
    if (step.clickedAt) clicked += 1;
  }
  return { sent, delivered, read, clicked, failed };
}

function safeRate(num, den) {
  if (!den || den <= 0) return 0;
  return num / den;
}

async function getHubStats(clientId, period = '7d') {
  const { from, to, label } = parsePeriod(period);
  const enrollMatch = {
    clientId,
    sourceFlowId: { $ne: '' },
    ...periodMatch('createdAt', from, to),
  };

  const enrollRows = await FollowUpSequence.aggregate([
    { $match: enrollMatch },
    {
      $group: {
        _id: null,
        uniqueRecipients: { $addToSet: '$leadId' },
        enrollments: { $sum: 1 },
      },
    },
  ]);
  const enrollRow = enrollRows[0] || {};
  const uniqueRecipients = (enrollRow.uniqueRecipients || []).length;

  const revMatch = {
    clientId,
    ...periodMatch('attributedAt', from, to),
  };
  const revRows = await JourneyRevenueAttribution.aggregate([
    { $match: revMatch },
    {
      $group: {
        _id: null,
        revenueInr: { $sum: '$amount' },
        attributedOrders: { $sum: 1 },
      },
    },
  ]);
  const revRow = revRows[0] || {};
  const revenueInr = Number(revRow.revenueInr || 0);
  const attributedOrders = Number(revRow.attributedOrders || 0);
  const conversionRate = safeRate(attributedOrders, uniqueRecipients);

  return {
    uniqueRecipients,
    uniqueEnrollments: uniqueRecipients,
    enrollments: enrollRow.enrollments || 0,
    journeyRevenueInr: revenueInr,
    conversionRate,
    attributedOrders,
    period: { from, to, label },
    isSample: false,
  };
}

async function getBlueprintStats(clientId, sourceFlowId, period = '7d') {
  const { from, to, label } = parsePeriod(period);
  const enrollMatch = {
    clientId,
    sourceFlowId,
    ...periodMatch('createdAt', from, to),
  };

  const sequences = await FollowUpSequence.find(enrollMatch)
    .select('leadId steps')
    .lean();

  const uniqueLeadIds = new Set();
  let engagement = { sent: 0, delivered: 0, read: 0, clicked: 0, failed: 0 };

  for (const seq of sequences) {
    if (seq.leadId) uniqueLeadIds.add(String(seq.leadId));
    const e = countEngagement(seq.steps || []);
    engagement.sent += e.sent;
    engagement.delivered += e.delivered;
    engagement.read += e.read;
    engagement.clicked += e.clicked;
    engagement.failed += e.failed;
  }

  const revMatch = {
    clientId,
    sourceFlowId,
    ...periodMatch('attributedAt', from, to),
  };
  const revRows = await JourneyRevenueAttribution.aggregate([
    { $match: revMatch },
    {
      $group: {
        _id: null,
        revenueInr: { $sum: '$amount' },
        attributedOrders: { $sum: 1 },
      },
    },
  ]);
  const revRow = revRows[0] || {};
  const revenueInr = Number(revRow.revenueInr || 0);
  const attributedOrders = Number(revRow.attributedOrders || 0);
  const uniqueRecipients = uniqueLeadIds.size;

  const lowVolume = engagement.sent < MIN_SAMPLE_SIZE;
  const openRate = safeRate(engagement.read, engagement.delivered || engagement.sent);
  const clickRate = safeRate(engagement.clicked, engagement.delivered || engagement.sent);
  const orderRate = safeRate(attributedOrders, uniqueRecipients);

  return {
    sourceFlowId,
    uniqueRecipients,
    revenueInr,
    openRate,
    clickRate,
    orderRate,
    sent: engagement.sent,
    delivered: engagement.delivered,
    read: engagement.read,
    clicked: engagement.clicked,
    failed: engagement.failed,
    attributedOrders,
    lowVolume,
    openRateUnavailable: false,
    period: { from, to, label },
    isSample: false,
  };
}

async function getStepFunnel(clientId, sourceFlowId, period = '7d') {
  const { from, to, label } = parsePeriod(period);
  const enrollMatch = {
    clientId,
    sourceFlowId,
    ...periodMatch('createdAt', from, to),
  };

  const sequences = await FollowUpSequence.find(enrollMatch).select('steps').lean();
  const funnelMap = new Map();

  for (const seq of sequences) {
    (seq.steps || []).forEach((step, stepIndex) => {
      if (!funnelMap.has(stepIndex)) {
        funnelMap.set(stepIndex, {
          stepIndex,
          type: step.type || 'whatsapp',
          templateName: step.templateName || '',
          sent: 0,
          delivered: 0,
          read: 0,
          clicked: 0,
          failed: 0,
          skipped: 0,
          pending: 0,
        });
      }
      const row = funnelMap.get(stepIndex);
      const st = String(step.status || 'pending');
      if (st === 'sent') row.sent += 1;
      else if (st === 'failed') row.failed += 1;
      else if (st === 'skipped') row.skipped += 1;
      else if (['pending', 'queued', 'processing', 'retrying'].includes(st)) row.pending += 1;
      if (step.deliveredAt) row.delivered += 1;
      if (step.readAt) row.read += 1;
      if (step.clickedAt) row.clicked += 1;
    });
  }

  return {
    sourceFlowId,
    steps: [...funnelMap.values()].sort((a, b) => a.stepIndex - b.stepIndex),
    period: { from, to, label },
  };
}

async function getBlueprintStatsMap(clientId, flowIds, period = '7d') {
  const map = new Map();
  const ids = [...new Set((flowIds || []).filter(Boolean))];
  await Promise.all(
    ids.map(async (flowId) => {
      const stats = await getBlueprintStats(clientId, flowId, period);
      map.set(flowId, stats);
    })
  );
  return map;
}

module.exports = {
  getHubStats,
  getBlueprintStats,
  getStepFunnel,
  getBlueprintStatsMap,
  parsePeriod,
  MIN_SAMPLE_SIZE,
};
