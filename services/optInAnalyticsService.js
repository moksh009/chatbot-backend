'use strict';

const OptInTool = require('../models/OptInTool');
const AdLead = require('../models/AdLead');

const RETENTION_DAYS = 90;
const DAILY_SERIES_DAYS = 30;

function mapToObject(value) {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  return typeof value === 'object' ? value : {};
}

function normalizeRollup(rollup) {
  if (!rollup) return { total: 0, byDay: {} };
  return {
    total: Number(rollup.total) || 0,
    byDay: mapToObject(rollup.byDay),
  };
}

function normalizePagePath(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return (parsed.pathname + (parsed.search || '')).slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}

function pageStorageKey(rawUrl) {
  const path = normalizePagePath(rawUrl);
  if (!path) return '';
  return path.replace(/\./g, '_').replace(/\//g, '__').slice(0, 120);
}

function prizeStorageKey(label) {
  return String(label || 'prize')
    .trim()
    .slice(0, 80)
    .replace(/\./g, '_');
}

function mergeDailySeries(impressionsByDay, signupsByDay, days = DAILY_SERIES_DAYS) {
  const dates = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates.map((date) => ({
    date,
    views: Number(impressionsByDay[date]) || 0,
    signups: Number(signupsByDay[date]) || 0,
  }));
}

function decodePageKey(key) {
  return String(key || '').replace(/__/g, '/');
}

function topPagesFromAnalytics(topPagesMap, limit = 10) {
  return Object.entries(mapToObject(topPagesMap))
    .map(([pageKey, views]) => ({
      page: decodePageKey(pageKey),
      views: Number(views) || 0,
    }))
    .filter((row) => row.views > 0)
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
}

async function recordImpression(clientId, toolId, { pageUrl, isMobile } = {}) {
  const day = new Date().toISOString().slice(0, 10);
  const inc = {
    'impressions.total': 1,
    [`impressions.byDay.${day}`]: 1,
  };
  inc[isMobile ? 'analytics.devices.mobile' : 'analytics.devices.desktop'] = 1;

  const pageKey = pageStorageKey(pageUrl);
  if (pageKey) {
    inc[`analytics.topPages.${pageKey}`] = 1;
  }

  await OptInTool.updateOne({ _id: toolId, clientId, status: 'live' }, { $inc: inc });
}

async function recordPrizeWin(clientId, toolId, prizeLabel) {
  const key = prizeStorageKey(prizeLabel);
  if (!key) return;
  await OptInTool.updateOne(
    { _id: toolId, clientId },
    { $inc: { [`analytics.prizeWins.${key}`]: 1 } }
  );
}

async function buildToolConversionReport(clientId, toolId) {
  const tool = await OptInTool.findOne({ _id: toolId, clientId }).lean();
  if (!tool) return null;

  const impressions = normalizeRollup(tool.impressions);
  const signups = normalizeRollup(tool.signups);
  const daily = mergeDailySeries(impressions.byDay, signups.byDay);

  let topPages = topPagesFromAnalytics(tool.analytics?.topPages);
  if (topPages.length === 0) {
    const leadPages = await AdLead.aggregate([
      { $match: { clientId, 'capturedData.optInToolId': String(toolId) } },
      { $unwind: '$optInHistory' },
      { $match: { 'optInHistory.pageUrl': { $exists: true, $ne: '' } } },
      { $group: { _id: '$optInHistory.pageUrl', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);
    topPages = leadPages.map((row) => ({
      page: normalizePagePath(row._id),
      views: row.count,
      source: 'signups',
    }));
  }

  const devices = {
    mobile: Number(tool.analytics?.devices?.mobile) || 0,
    desktop: Number(tool.analytics?.devices?.desktop) || 0,
  };

  let prizeDistribution = Object.entries(mapToObject(tool.analytics?.prizeWins))
    .map(([label, count]) => ({ label, count: Number(count) || 0 }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);

  if (
    (tool.type === 'spin_wheel' || tool.type === 'mystery_discount') &&
    prizeDistribution.length === 0
  ) {
    const prizeRows = await AdLead.aggregate([
      { $match: { clientId, 'capturedData.optInToolId': String(toolId), 'capturedData.prizeLabel': { $exists: true, $ne: '' } } },
      { $group: { _id: '$capturedData.prizeLabel', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    prizeDistribution = prizeRows.map((row) => ({ label: row._id, count: row.count }));
  }

  const views = impressions.total;
  const signupTotal = signups.total;
  const signupRate = views > 0 ? Math.round((signupTotal / views) * 1000) / 10 : 0;

  return {
    tool: {
      id: String(tool._id),
      name: tool.name,
      type: tool.type,
      status: tool.status,
    },
    summary: {
      views,
      signups: signupTotal,
      signupRate,
      couponRedemptions: Number(tool.couponRedemptions?.total) || 0,
    },
    daily,
    topPages,
    devices,
    prizeDistribution,
    hasData: views > 0 || signupTotal > 0,
  };
}

function reportToCsv(report) {
  if (!report) return '';
  const lines = [
    `# Opt-in tool report: ${report.tool?.name || 'tool'}`,
    `views,${report.summary?.views || 0}`,
    `signups,${report.summary?.signups || 0}`,
    `signup_rate_pct,${report.summary?.signupRate || 0}`,
    '',
    'date,views,signups',
  ];
  for (const row of report.daily || []) {
    lines.push(`${row.date},${row.views},${row.signups}`);
  }
  lines.push('', 'page,views');
  for (const row of report.topPages || []) {
    lines.push(`"${String(row.page).replace(/"/g, '""')}",${row.views}`);
  }
  if (report.prizeDistribution?.length) {
    lines.push('', 'prize,count');
    for (const row of report.prizeDistribution) {
      lines.push(`"${String(row.label).replace(/"/g, '""')}",${row.count}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function rollupOptInAnalyticsForTool(tool) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffDay = cutoff.toISOString().slice(0, 10);

  const impByDay = mapToObject(tool.impressions?.byDay);
  const sigByDay = mapToObject(tool.signups?.byDay);
  const newImpByDay = {};
  const newSigByDay = {};

  for (const [day, val] of Object.entries(impByDay)) {
    if (day >= cutoffDay) newImpByDay[day] = Number(val) || 0;
  }
  for (const [day, val] of Object.entries(sigByDay)) {
    if (day >= cutoffDay) newSigByDay[day] = Number(val) || 0;
  }

  const updates = {};
  if (JSON.stringify(newImpByDay) !== JSON.stringify(impByDay)) {
    updates['impressions.byDay'] = newImpByDay;
  }
  if (JSON.stringify(newSigByDay) !== JSON.stringify(sigByDay)) {
    updates['signups.byDay'] = newSigByDay;
  }

  if (Object.keys(updates).length === 0) return { pruned: false };

  await OptInTool.updateOne({ _id: tool._id }, { $set: updates });
  return { pruned: true };
}

async function rollupOptInAnalyticsAllClients() {
  const tools = await OptInTool.find({})
    .select('_id impressions signups')
    .lean();
  let pruned = 0;
  for (const tool of tools) {
    const result = await rollupOptInAnalyticsForTool(tool);
    if (result.pruned) pruned += 1;
  }
  return { tools: tools.length, pruned };
}

module.exports = {
  RETENTION_DAYS,
  DAILY_SERIES_DAYS,
  normalizePagePath,
  pageStorageKey,
  recordImpression,
  recordPrizeWin,
  buildToolConversionReport,
  reportToCsv,
  rollupOptInAnalyticsForTool,
  rollupOptInAnalyticsAllClients,
};
