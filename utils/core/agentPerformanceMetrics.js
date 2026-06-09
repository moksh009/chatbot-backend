'use strict';

const Conversation = require('../../models/Conversation');
const Message = require('../../models/Message');
const { getSupportPipelineCounts } = require('./supportConversationMetrics');
const { getOperatorsStats } = require('./analyticsHelper');

const MAX_FRT_SEC = 30 * 60; // 30 min — exclude stale / multi-day gaps
const MAX_RES_SEC = 72 * 3600; // 72h — resolution SLA window
const MIN_RES_SEC = 30; // ignore instant auto-close noise

function median(values) {
  if (!values?.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Human-readable duration from seconds (for API + UI).
 */
function formatDurationSeconds(totalSec) {
  if (totalSec == null || !Number.isFinite(totalSec) || totalSec < 0) {
    return { display: '—', hint: 'No conversations with measurable reply time in this window' };
  }
  if (totalSec < 60) {
    return { display: `${Math.round(totalSec)}s`, hint: null };
  }
  if (totalSec < 3600) {
    return { display: `${(totalSec / 60).toFixed(1)}m`, hint: null };
  }
  if (totalSec < 86400) {
    const hours = totalSec / 3600;
    return {
      display: `${hours.toFixed(1)}h`,
      hint: hours >= 2 ? `≈ ${Math.round(totalSec / 60)} minutes` : null,
    };
  }
  const days = totalSec / 86400;
  return {
    display: `${days.toFixed(1)}d`,
    hint: `≈ ${(totalSec / 3600).toFixed(0)} hours`,
  };
}

/**
 * First customer message → first reply (bot or agent) per conversation.
 */
async function computeFirstResponseTimes(clientId, since, options = {}) {
  const limit = options.conversationLimit || 2500;
  const convoIds = await Conversation.find({ clientId, updatedAt: { $gte: since } })
    .select('_id')
    .limit(limit)
    .lean();

  if (!convoIds.length) return [];

  const idList = convoIds.map((c) => c._id);
  const rows = await Message.aggregate([
    {
      $match: {
        clientId,
        conversationId: { $in: idList },
        direction: { $in: ['incoming', 'outgoing'] },
      },
    },
    { $sort: { timestamp: 1 } },
    {
      $group: {
        _id: '$conversationId',
        msgs: { $push: { d: '$direction', t: '$timestamp' } },
      },
    },
  ]);

  const samples = [];
  for (const row of rows) {
    let firstIn = null;
    for (const m of row.msgs) {
      if (m.d === 'incoming') {
        if (!firstIn) firstIn = new Date(m.t).getTime();
      } else if (m.d === 'outgoing' && firstIn) {
        const sec = (new Date(m.t).getTime() - firstIn) / 1000;
        if (sec >= 0 && sec <= MAX_FRT_SEC) samples.push(sec);
        break;
      }
    }
  }
  return samples;
}

/**
 * Time from human assignment (or first customer message) to resolvedAt.
 */
async function computeResolutionTimes(clientId, since, options = {}) {
  const limit = options.resolvedLimit || 1500;
  const resolved = await Conversation.find({
    clientId,
    resolvedAt: { $gte: since, $ne: null },
  })
    .select('_id resolvedAt')
    .limit(limit)
    .lean();

  if (!resolved.length) return [];

  const convoIdList = resolved.map((c) => c._id);
  const [assignments, firstIncomingRows] = await Promise.all([
    ConversationAssignment.find({
      clientId,
      conversationId: { $in: convoIdList },
    })
      .select('conversationId assignedAt')
      .sort({ assignedAt: 1 })
      .lean(),
    Message.aggregate([
      {
        $match: {
          clientId,
          conversationId: { $in: convoIdList },
          direction: 'incoming',
        },
      },
      { $sort: { timestamp: 1 } },
      {
        $group: {
          _id: '$conversationId',
          firstAt: { $first: '$timestamp' },
        },
      },
    ]),
  ]);

  const firstAssignByConvo = new Map();
  for (const a of assignments) {
    const key = String(a.conversationId);
    if (!firstAssignByConvo.has(key)) firstAssignByConvo.set(key, a.assignedAt);
  }

  const firstInByConvo = new Map(
    firstIncomingRows.map((r) => [String(r._id), r.firstAt])
  );

  const samples = [];
  for (const c of resolved) {
    const key = String(c._id);
    const start = firstAssignByConvo.get(key) || firstInByConvo.get(key);
    if (!start || !c.resolvedAt) continue;
    const sec = (new Date(c.resolvedAt).getTime() - new Date(start).getTime()) / 1000;
    if (sec >= MIN_RES_SEC && sec <= MAX_RES_SEC) samples.push(sec);
  }
  return samples;
}

async function getAgentPerformanceMetrics(clientId, since) {
  const days = Math.max(
    1,
    Math.min(Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000)), 365)
  );

  const [frtSamples, resSamples, pipeline, operatorsPayload, csatConvos] = await Promise.all([
    computeFirstResponseTimes(clientId, since),
    computeResolutionTimes(clientId, since),
    getSupportPipelineCounts(clientId, since),
    getOperatorsStats(clientId, days),
    Conversation.find({
      clientId,
      updatedAt: { $gte: since },
      'csatScore.rating': { $exists: true },
    })
      .select('csatScore')
      .lean(),
  ]);

  const medianFrt = median(frtSamples);
  const medianRes = median(resSamples);
  const frtFormatted = formatDurationSeconds(medianFrt);
  const resFormatted = formatDurationSeconds(medianRes);

  const resolved = pipeline.resolved || 0;
  const open = pipeline.open || 0;
  const total = Math.max(pipeline.total || 0, resolved + open);
  const actionableTotal = resolved + open;
  const resolutionRate =
    actionableTotal > 0 ? ((resolved / actionableTotal) * 100).toFixed(1) : '0';

  const totalScore = csatConvos.reduce((sum, c) => sum + (c.csatScore?.rating ?? 0), 0);
  const avgCSAT = csatConvos.length > 0 ? (totalScore / csatConvos.length).toFixed(1) : '0';

  const humanOperators = (operatorsPayload.operators || []).filter((o) => !o.isBot);
  const agentsOut = humanOperators.map((a) => ({
    name: a.agentName,
    email: a.agentEmail,
    role: 'AGENT',
    resolutions: a.ticketsSolved || 0,
    totalHandled: a.totalHandled || 0,
    currentOpen: a.currentOpenTickets || 0,
    resolutionPct:
      a.totalHandled > 0 ? ((a.ticketsSolved / a.totalHandled) * 100).toFixed(0) : '0',
  }));

  return {
    avgFRT: frtFormatted.display,
    avgFRTHint: frtFormatted.hint,
    avgFRTSeconds: medianFrt,
    frtSampleCount: frtSamples.length,
    resolutionRate: `${resolutionRate}%`,
    avgResolutionTime: resFormatted.display,
    avgResolutionHint: resFormatted.hint,
    avgResolutionSeconds: medianRes,
    resolutionSampleCount: resSamples.length,
    activeAgents: humanOperators.length,
    avgCSAT: `${avgCSAT}/5`,
    totalConversations: total,
    resolvedConversations: resolved,
    openConversations: pipeline.openConversations || [],
    teamAvgResponseTimeMs: operatorsPayload.teamAvgResponseTimeMs ?? null,
    agents: agentsOut,
    pipeline: {
      total,
      resolved,
      open,
      awaitingInput: pipeline.awaitingInput || 0,
      humanTakeover: pipeline.humanTakeover || 0,
    },
  };
}

module.exports = {
  formatDurationSeconds,
  median,
  computeFirstResponseTimes,
  computeResolutionTimes,
  getAgentPerformanceMetrics,
};
