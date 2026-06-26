'use strict';

const Segment = require('../models/Segment');
const TRACKABLE_ASSETS = require('../constants/trackableAssets');
const { phoneSuffixKey } = require('../utils/shopify/customerOrderAttribution');
const { mapFrequencyToOperator } = require('./SegmentQueryBuilderV2');
const {
  ensureConditionTree,
  isGroupNode,
  isRuleNode,
  RULE_KINDS,
} = require('../utils/segmentConditionUtils');
const { getCatalogEntryByAssetId } = require('../constants/segmentRuleCatalog');

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).split('.').reduce((acc, key) => (acc != null ? acc[key] : undefined), obj);
}

function daysSince(dateVal) {
  if (!dateVal) return null;
  const d = new Date(dateVal);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(Math.abs(Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function getTimeFrameDateField(assetId) {
  if (assetId === 'TOTAL_ORDERS') return 'lastPurchaseDate';
  if (assetId === 'CHECKOUTS_STARTED' || assetId === 'TOTAL_INTERACTIONS' || assetId === 'ABANDONED_CARTS') {
    return 'lastInteraction';
  }
  return 'lastInteraction';
}

function rowPassesTimeFrame(row, rule, assetId) {
  const frame = String(rule.timeFrame || 'all_time').toLowerCase();
  if (frame === 'all_time') return true;

  const field = getTimeFrameDateField(assetId);
  const raw = getByPath(row, field) || row[field] || row.lastOrderAt;
  const dateVal = raw ? new Date(raw) : null;

  if (frame === 'within_last') {
    const days = parseInt(rule.timeValue, 10);
    if (Number.isNaN(days) || days <= 0) return true;
    const since = new Date();
    since.setDate(since.getDate() - days);
    return dateVal && dateVal >= since;
  }

  if (frame === 'not_within_last') {
    const days = parseInt(rule.timeValue, 10);
    if (Number.isNaN(days) || days <= 0) return !dateVal;
    const before = new Date();
    before.setDate(before.getDate() - days);
    return !dateVal || dateVal < before;
  }

  if (frame === 'before') {
    const d = rule.timeValue ? new Date(rule.timeValue) : null;
    if (!d || Number.isNaN(d.getTime())) return true;
    return dateVal && dateVal < d;
  }

  if (frame === 'after') {
    const d = rule.timeValue ? new Date(rule.timeValue) : null;
    if (!d || Number.isNaN(d.getTime())) return true;
    return dateVal && dateVal > d;
  }

  if (frame === 'between') {
    const start = rule.timeValue ? new Date(rule.timeValue) : null;
    const end = rule.timeValueEnd ? new Date(rule.timeValueEnd) : null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return true;
    return dateVal && dateVal >= start && dateVal <= end;
  }

  return true;
}

function evaluateTextRule(fieldVal, textOperator, targetValue) {
  const val = String(fieldVal ?? '').trim();
  const target = String(targetValue ?? '').trim();
  const valLower = val.toLowerCase();
  const targetLower = target.toLowerCase();
  const op = String(textOperator || 'equals').toLowerCase();

  switch (op) {
    case 'equals':
      return valLower === targetLower;
    case 'not_equals':
      return valLower !== targetLower;
    case 'contains':
      return targetLower.length > 0 && valLower.includes(targetLower);
    case 'not_contains':
      return targetLower.length === 0 || !valLower.includes(targetLower);
    case 'is_set':
      return val.length > 0;
    case 'is_not_set':
      return val.length === 0;
    default:
      return false;
  }
}

function getRowFieldValue(row, asset) {
  if (!asset) return undefined;
  if (asset.id === 'AOV' || asset.type === 'COMPUTED_NUMBER') {
    const spent = Number(row.totalSpent) || 0;
    const orders = Number(row.ordersCount) || 0;
    return orders > 0 ? spent / orders : 0;
  }
  if (asset.id === 'LEAD_SCORE') return row.leadScore;
  if (asset.type === 'TEXT' || asset.id === 'NAME' || asset.id === 'EMAIL' || asset.id === 'PHONE') {
    return getByPath(row, asset.dbField) ?? row[asset.dbField];
  }
  if (asset.type === 'STRING' && asset.id === 'HAS_TAG') {
    return row.tags;
  }
  if (asset.type === 'STRING') {
    return getByPath(row, asset.dbField);
  }
  return row[asset.dbField] ?? getByPath(row, asset.dbField);
}

function evaluateNumericComparison(val, target, operator, targetEnd) {
  if (Number.isNaN(val)) return false;
  if (operator === 'between') {
    const end = parseFloat(targetEnd);
    const start = parseFloat(target);
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    return val >= Math.min(start, end) && val <= Math.max(start, end);
  }
  const t = parseFloat(target);
  if (Number.isNaN(t)) return false;
  if (operator === '>=') return val >= t;
  if (operator === '<=') return val <= t;
  if (operator === '===') return val === t;
  return false;
}

function evaluateRuleOnRow(row, rule = {}) {
  const asset = TRACKABLE_ASSETS.ASSETS[rule.assetId];
  const catalogEntry = getCatalogEntryByAssetId(rule.assetId);

  if (!asset && !catalogEntry) return false;

  if (!rowPassesTimeFrame(row, rule, rule.assetId)) return false;

  let operator = rule.operator;
  let targetValue = rule.targetValue;
  if (rule.frequency && asset && asset.type === 'NUMBER') {
    const mapped = mapFrequencyToOperator(rule.frequency, rule.targetValue);
    operator = mapped.operator;
    targetValue = mapped.targetValue;
  }

  if (rule.assetId === 'JUST_LANDED' || asset?.id === 'JUST_LANDED') {
    const isJustLanded = (Number(row.ordersCount) || 0) === 0 && (Number(row.inboundMessageCount) || 0) <= 1;
    const want = targetValue === true || targetValue === 'true';
    return want ? isJustLanded : !isJustLanded;
  }

  if (asset?.type === 'TEXT' || rule.assetId === 'NAME' || rule.assetId === 'EMAIL' || rule.assetId === 'PHONE') {
    const fieldVal = getRowFieldValue(row, asset);
    return evaluateTextRule(fieldVal, rule.textOperator || 'contains', targetValue);
  }

  if (asset?.type === 'CALCULATED_DAYS') {
    const days = daysSince(getByPath(row, asset.dbField) || row[asset.dbField]);
    if (days === null) return operator === '>=';
    const target = parseInt(targetValue, 10);
    if (Number.isNaN(target)) return false;
    if (operator === '>=') return days >= target;
    if (operator === '<=') return days <= target;
    if (operator === '===') return days === target;
    return false;
  }

  if (asset?.type === 'STRING' && asset.id === 'HAS_TAG') {
    const tags = Array.isArray(row.tags) ? row.tags : [];
    const want = String(targetValue ?? '').trim();
    const op = rule.textOperator || 'equals';
    if (op === 'contains') {
      return tags.some((t) => String(t).toLowerCase().includes(want.toLowerCase()));
    }
    return tags.some((t) => String(t).trim() === want);
  }

  if (asset?.type === 'STRING') {
    const fieldVal = getRowFieldValue(row, asset);
    if (rule.textOperator) {
      return evaluateTextRule(fieldVal, rule.textOperator, targetValue);
    }
    const leadVal = String(fieldVal ?? '').trim();
    const target = String(targetValue ?? '').trim();
    if (operator === '!==') return leadVal !== target;
    return leadVal === target;
  }

  if (asset?.type === 'BOOLEAN') {
    const leadVal = Boolean(getRowFieldValue(row, asset));
    const b = targetValue === true || targetValue === 'true';
    return leadVal === b;
  }

  const leadVal = getRowFieldValue(row, asset);
  const val = parseFloat(leadVal);
  return evaluateNumericComparison(val, targetValue, operator, rule.targetValueEnd);
}

async function getSegmentMemberSuffixSet(clientId, segmentId, ctx) {
  const cache = ctx.memberCache;
  const key = String(segmentId);
  if (cache.has(key)) return cache.get(key);

  const visited = new Set(ctx.visitedSegments || []);
  if (visited.has(key)) return new Set();
  visited.add(key);

  const segment = await Segment.findOne({ _id: segmentId, clientId })
    .select('conditionTree conditions query name')
    .lean();
  if (!segment) {
    cache.set(key, new Set());
    return cache.get(key);
  }

  const tree = ensureConditionTree(segment);
  const rows = ctx.allRows || (await loadUnifiedAudienceRows(clientId));
  const suffixes = new Set();
  for (const row of rows) {
    const match = await evaluateTreeOnRow(row, tree, {
      ...ctx,
      allRows: rows,
      visitedSegments: visited,
    });
    if (match) {
      const suffix = phoneSuffixKey(row.phoneNumber);
      if (suffix) suffixes.add(suffix);
    }
  }
  cache.set(key, suffixes);
  return suffixes;
}

async function evaluateMembershipRule(row, rule, ctx) {
  const segmentId = String(rule.segmentId || '').trim();
  if (!segmentId) return false;
  const suffix = phoneSuffixKey(row.phoneNumber);
  if (!suffix) return false;
  const memberSet = await getSegmentMemberSuffixSet(ctx.clientId, segmentId, ctx);
  const isMember = memberSet.has(suffix);
  return rule.membershipOperator === 'not_in' ? !isMember : isMember;
}

async function evaluateTreeOnRow(row, node, ctx = {}) {
  if (!node) return false;
  if (isRuleNode(node)) {
    if (node.ruleKind === RULE_KINDS.SEGMENT_MEMBERSHIP || node.segmentId) {
      return evaluateMembershipRule(row, node, ctx);
    }
    return evaluateRuleOnRow(row, node);
  }
  if (!isGroupNode(node)) return false;

  const children = node.children || [];
  if (!children.length) return false;
  const op = String(node.operator || 'AND').toUpperCase();
  if (op === 'OR') {
    for (const child of children) {
      if (await evaluateTreeOnRow(row, child, ctx)) return true;
    }
    return false;
  }
  for (const child of children) {
    if (!(await evaluateTreeOnRow(row, child, ctx))) return false;
  }
  return true;
}

async function loadUnifiedAudienceRows(clientId) {
  const { loadUnifiedAudienceForSegments } = require('../utils/commerce/leadsAnalyticsFacet');
  return loadUnifiedAudienceForSegments(clientId);
}

async function filterUnifiedAudience(clientId, conditionTreeOrSegment, opts = {}) {
  const tree = conditionTreeOrSegment?.conditionTree
    ? ensureConditionTree(conditionTreeOrSegment)
    : ensureConditionTree({ conditionTree: conditionTreeOrSegment });

  const rows = opts.allRows || (await loadUnifiedAudienceRows(clientId));
  const ctx = {
    clientId,
    memberCache: new Map(),
    visitedSegments: new Set(),
    allRows: rows,
  };

  const matched = [];
  for (const row of rows) {
    if (await evaluateTreeOnRow(row, tree, ctx)) matched.push(row);
  }

  let result = matched;
  const search = String(opts.search || '').trim().toLowerCase();
  if (search) {
    result = result.filter(
      (r) =>
        String(r.name || '').toLowerCase().includes(search) ||
        String(r.phoneNumber || '').toLowerCase().includes(search) ||
        String(r.email || '').toLowerCase().includes(search)
    );
  }

  result.sort((a, b) => {
    const da = new Date(a.lastInteraction || a.displayLastSeenAt || a.lastOrderAt || 0).getTime();
    const db = new Date(b.lastInteraction || b.displayLastSeenAt || b.lastOrderAt || 0).getTime();
    return db - da;
  });

  return { rows: result, totalAudience: rows.length, tree };
}

async function countUnifiedSegment(clientId, conditionTreeOrSegment) {
  const { rows, totalAudience } = await filterUnifiedAudience(clientId, conditionTreeOrSegment);
  return { count: rows.length, totalAudience };
}

async function resolveSegmentAudienceRows(clientId, segmentOrTree, opts = {}) {
  const { rows } = await filterUnifiedAudience(clientId, segmentOrTree, opts);
  return rows.map((r) => ({
    _id: r._id,
    phone: r.phoneNumber,
    phoneNumber: r.phoneNumber,
    email: r.email || '',
    name: r.name || 'Customer',
    optStatus: r.optStatus,
    optInSource: r.optInSource,
    ordersCount: r.ordersCount,
    totalSpent: r.totalSpent,
  }));
}

async function leadMatchesUnifiedSegment(clientId, lead, segmentId) {
  if (!clientId || !segmentId) return false;
  const phone = lead?.phoneNumber || lead?.phone;
  if (!phone) return false;

  const segment = await Segment.findOne({ _id: segmentId, clientId }).lean();
  if (!segment) return false;

  const rows = await loadUnifiedAudienceRows(clientId);
  const suffix = phoneSuffixKey(phone);
  const row = rows.find((r) => phoneSuffixKey(r.phoneNumber) === suffix);
  if (!row) return false;

  const tree = ensureConditionTree(segment);
  return evaluateTreeOnRow(row, tree, {
    clientId,
    memberCache: new Map(),
    visitedSegments: new Set(),
    allRows: rows,
  });
}

module.exports = {
  evaluateRuleOnRow,
  evaluateTreeOnRow,
  evaluateTextRule,
  filterUnifiedAudience,
  countUnifiedSegment,
  loadUnifiedAudienceRows,
  resolveSegmentAudienceRows,
  leadMatchesUnifiedSegment,
};
