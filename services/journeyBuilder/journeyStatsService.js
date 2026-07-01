'use strict';

const FollowUpSequence = require('../../models/FollowUpSequence');
const JourneyRevenueAttribution = require('../../models/JourneyRevenueAttribution');
const WhatsAppFlow = require('../../models/WhatsAppFlow');
const { compileGraphToSteps } = require('./compileGraphToSteps');

const MIN_SAMPLE_SIZE = 10;

// ---------------------------------------------------------------------------
// Canonical step-counting helpers — single source of truth for all analytics
// surfaces (getBlueprintStats, getStepFunnel, emitSequenceProgress, drawer).
// Rule: sent and failed are MUTUALLY EXCLUSIVE.
// A step that was sent (sentAt set) but later received a Meta 'failed' webhook
// will have status:'failed' AND sentAt populated.  Under the old rule it
// counted in BOTH buckets.  These helpers fix that.
// ---------------------------------------------------------------------------

/** True if the step was successfully dispatched and has NOT since been failed. */
function isStepSent(step) {
  return (step.status === 'sent' || !!step.sentAt) && step.status !== 'failed';
}

/** True if the step has reached a terminal failed state. */
function isStepFailed(step) {
  return step.status === 'failed';
}

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

function isStepSkipped(step) {
  return step.status === 'skipped';
}

function countEngagement(steps = []) {
  let sent = 0;
  let delivered = 0;
  let read = 0;
  let clicked = 0;
  let failed = 0;
  let skipped = 0;
  for (const step of steps) {
    if (isStepSent(step)) sent += 1;
    if (isStepFailed(step)) failed += 1;
    if (isStepSkipped(step)) skipped += 1;
    if (step.deliveredAt) delivered += 1;
    if (step.readAt) read += 1;
    if (step.clickedAt) clicked += 1;
  }
  return { sent, delivered, read, clicked, failed, skipped };
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
  const uniqueRecipients = (enrollRow.uniqueRecipients || []).filter(Boolean).length;
  const enrollments = Number(enrollRow.enrollments || 0);

  const msgRows = await FollowUpSequence.aggregate([
    { $match: enrollMatch },
    { $unwind: '$steps' },
    {
      $group: {
        _id: null,
        messagesSent: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$steps.status', 'failed'] },
                  {
                    $or: [
                      { $eq: ['$steps.status', 'sent'] },
                      { $ne: [{ $ifNull: ['$steps.sentAt', null] }, null] },
                    ],
                  },
                ],
              },
              1,
              0,
            ],
          },
        },
        messagesFailed: {
          $sum: { $cond: [{ $eq: ['$steps.status', 'failed'] }, 1, 0] },
        },
      },
    },
  ]);
  const msgRow = msgRows[0] || {};
  const messagesSent = Number(msgRow.messagesSent || 0);
  const messagesFailed = Number(msgRow.messagesFailed || 0);

  const revMatch = {
    clientId,
    ...periodMatch('attributedAt', from, to),
  };
  const revRows = await JourneyRevenueAttribution.aggregate([
    { $match: revMatch },
    {
      $group: {
        _id: { $ifNull: ['$journeyType', 'other'] },
        revenueInr: { $sum: '$amount' },
        attributedOrders: { $sum: 1 },
      },
    },
  ]);
  let revenueInr = 0;
  let attributedOrders = 0;
  let cartRecoveryRevenue = 0;
  let cartRecoveryOrders = 0;
  for (const row of revRows) {
    const rev = Number(row.revenueInr || 0);
    const orders = Number(row.attributedOrders || 0);
    revenueInr += rev;
    attributedOrders += orders;
    if (row._id === 'cart_abandoned') {
      cartRecoveryRevenue += rev;
      cartRecoveryOrders += orders;
    }
  }
  const conversionRate = safeRate(attributedOrders, uniqueRecipients);

  return {
    uniqueRecipients,
    uniqueEnrollments: uniqueRecipients,
    enrollments,
    messagesSent,
    messagesFailed,
    journeyRevenueInr: revenueInr,
    conversionRate,
    attributedOrders,
    revenueBySource: {
      cartRecovery: { revenue: cartRecoveryRevenue, orders: cartRecoveryOrders },
      other: { revenue: revenueInr - cartRecoveryRevenue, orders: attributedOrders - cartRecoveryOrders },
    },
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
  let engagement = { sent: 0, delivered: 0, read: 0, clicked: 0, failed: 0, skipped: 0 };

  for (const seq of sequences) {
    if (seq.leadId) uniqueLeadIds.add(String(seq.leadId));
    const e = countEngagement(seq.steps || []);
    engagement.sent += e.sent;
    engagement.delivered += e.delivered;
    engagement.read += e.read;
    engagement.clicked += e.clicked;
    engagement.failed += e.failed;
    engagement.skipped += e.skipped;
  }

  const revMatch = {
    clientId,
    sourceFlowId,
    ...periodMatch('attributedAt', from, to),
  };
  // Revenue split: confirmed (click-driven) vs probable (send-only).
  const revRows = await JourneyRevenueAttribution.aggregate([
    { $match: revMatch },
    {
      $group: {
        _id: { $cond: [{ $eq: ['$clickDriven', true] }, 'confirmed', 'probable'] },
        revenueInr: { $sum: '$amount' },
        attributedOrders: { $sum: 1 },
      },
    },
  ]);

  let revenueInr = 0;
  let confirmedRevenueInr = 0;
  let probableRevenueInr = 0;
  let attributedOrders = 0;
  for (const row of revRows) {
    const rev = Number(row.revenueInr || 0);
    const orders = Number(row.attributedOrders || 0);
    revenueInr += rev;
    attributedOrders += orders;
    if (row._id === 'confirmed') confirmedRevenueInr = rev;
    else probableRevenueInr = rev;
  }

  const uniqueRecipients = uniqueLeadIds.size;

  const lowVolume = engagement.sent < MIN_SAMPLE_SIZE;
  const openRate = safeRate(engagement.read, engagement.delivered || engagement.sent);
  const clickRate = safeRate(engagement.clicked, engagement.delivered || engagement.sent);
  const orderRate = safeRate(attributedOrders, uniqueRecipients);

  return {
    sourceFlowId,
    uniqueRecipients,
    revenueInr,
    confirmedRevenueInr,
    probableRevenueInr,
    openRate,
    clickRate,
    orderRate,
    sent: engagement.sent,
    delivered: engagement.delivered,
    read: engagement.read,
    clicked: engagement.clicked,
    failed: engagement.failed,
    skipped: engagement.skipped,
    attributedOrders,
    lowVolume,
    openRateUnavailable: false,
    period: { from, to, label },
    isSample: false,
  };
}

function enrichFunnelStepsWithCompiledGraph(graph, funnelSteps = []) {
  if (!graph?.nodes?.length || !funnelSteps.length) return funnelSteps;
  let compiled = [];
  try {
    compiled = compileGraphToSteps(graph).steps || [];
  } catch {
    return funnelSteps;
  }
  const byIndex = new Map(compiled.map((s, i) => [i, s]));
  const byNodeId = new Map(
    compiled.filter((s) => s.graphNodeId).map((s) => [String(s.graphNodeId), s])
  );

  return funnelSteps.map((row) => {
    const def =
      byIndex.get(row.stepIndex)
      || (row.graphNodeId ? byNodeId.get(String(row.graphNodeId)) : null);
    if (!def) return row;
    return {
      ...row,
      templateName: row.templateName || def.templateName || '',
      subject: row.subject || def.subject || '',
    };
  });
}

async function getStepFunnel(clientId, sourceFlowId, period = '7d') {
  const { from, to, label } = parsePeriod(period);
  const enrollMatch = {
    clientId,
    sourceFlowId,
    ...periodMatch('createdAt', from, to),
  };

  const sequences = await FollowUpSequence.find(enrollMatch).select('steps').lean();

  // Two maps: indexed by stepIndex (for ordering) and by graphNodeId (for canvas mapping)
  const funnelByIndex = new Map();
  const funnelByNodeId = new Map();

  for (const seq of sequences) {
    (seq.steps || []).forEach((step, stepIndex) => {
      const st = String(step.status || 'pending');
      const isSent = isStepSent(step);
      const isFailed = isStepFailed(step);
      const isSkipped = st === 'skipped';
      const isPending = ['pending', 'queued', 'processing', 'retrying'].includes(st);

      const nodeId = String(step.graphNodeId || '');

      // Update by-index map (used by drawer funnel table)
      if (!funnelByIndex.has(stepIndex)) {
        funnelByIndex.set(stepIndex, {
          stepIndex,
          graphNodeId: nodeId,
          type: step.type || 'whatsapp',
          templateName: step.templateName || '',
          subject: step.subject || '',
          sent: 0, delivered: 0, read: 0, clicked: 0,
          failed: 0, skipped: 0, pending: 0,
        });
      }
      const row = funnelByIndex.get(stepIndex);
      if (!row.graphNodeId && nodeId) row.graphNodeId = nodeId;
      if (!row.templateName && step.templateName) row.templateName = step.templateName;
      if (!row.subject && step.subject) row.subject = step.subject;
      if (isSent) row.sent += 1;
      if (isFailed) row.failed += 1;
      if (isSkipped) row.skipped += 1;
      if (isPending) row.pending += 1;
      if (step.deliveredAt) row.delivered += 1;
      if (step.readAt) row.read += 1;
      if (step.clickedAt) row.clicked += 1;

      // Update by-nodeId map (used by canvas overlay for stable node-level stats)
      if (nodeId) {
        if (!funnelByNodeId.has(nodeId)) {
          funnelByNodeId.set(nodeId, {
            graphNodeId: nodeId,
            stepIndex,
            type: step.type || 'whatsapp',
            templateName: step.templateName || '',
            subject: step.subject || '',
            sent: 0, delivered: 0, read: 0, clicked: 0,
            failed: 0, skipped: 0, pending: 0,
          });
        }
        const nRow = funnelByNodeId.get(nodeId);
        if (!nRow.templateName && step.templateName) nRow.templateName = step.templateName;
        if (!nRow.subject && step.subject) nRow.subject = step.subject;
        if (isSent) nRow.sent += 1;
        if (isFailed) nRow.failed += 1;
        if (isSkipped) nRow.skipped += 1;
        if (isPending) nRow.pending += 1;
        if (step.deliveredAt) nRow.delivered += 1;
        if (step.readAt) nRow.read += 1;
        if (step.clickedAt) nRow.clicked += 1;
      }
    });
  }

  const rawSteps = [...funnelByIndex.values()].sort((a, b) => a.stepIndex - b.stepIndex);
  const flow = await WhatsAppFlow.findOne({ clientId, flowId: sourceFlowId })
    .select('graph')
    .lean();
  const steps = enrichFunnelStepsWithCompiledGraph(flow?.graph, rawSteps);
  const enrichedByNodeId = { ...Object.fromEntries(funnelByNodeId) };
  for (const row of steps) {
    if (row.graphNodeId && enrichedByNodeId[row.graphNodeId]) {
      enrichedByNodeId[row.graphNodeId] = {
        ...enrichedByNodeId[row.graphNodeId],
        templateName: row.templateName || enrichedByNodeId[row.graphNodeId].templateName || '',
        subject: row.subject || enrichedByNodeId[row.graphNodeId].subject || '',
      };
    }
  }

  return {
    sourceFlowId,
    steps,
    byNodeId: enrichedByNodeId,
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
  isStepSent,
  isStepFailed,
  isStepSkipped,
  enrichFunnelStepsWithCompiledGraph,
};
