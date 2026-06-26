'use strict';

const TRACKABLE_ASSETS = require('../constants/trackableAssets');
const { isGroupNode, isRuleNode, RULE_KINDS } = require('../utils/segmentConditionUtils');

const TIME_FRAME_DATE_FIELDS = {
  TOTAL_ORDERS: 'lastPurchaseDate',
  CHECKOUTS_STARTED: 'lastInteraction',
  TOTAL_INTERACTIONS: 'lastInteraction',
  ABANDONED_CARTS: 'lastInteraction',
};

function mapFrequencyToOperator(frequency, targetValue) {
  const f = String(frequency || '').toLowerCase();
  const x = parseFloat(targetValue);
  if (f === 'zero_times') return { operator: '===', targetValue: 0 };
  if (f === 'atleast_once') return { operator: '>=', targetValue: 1 };
  if (f === 'exactly_x') return { operator: '===', targetValue: Number.isFinite(x) ? x : 0 };
  if (f === 'atmost_x') return { operator: '<=', targetValue: Number.isFinite(x) ? x : 0 };
  if (f === 'atleast_x') return { operator: '>=', targetValue: Number.isFinite(x) ? x : 1 };
  return { operator: '>=', targetValue: Number.isFinite(x) ? x : targetValue };
}

function parseDateInput(val) {
  if (!val) return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildTimeFrameClause(rule, assetId) {
  const frame = String(rule.timeFrame || 'all_time').toLowerCase();
  if (frame === 'all_time') return null;

  const dateField = TIME_FRAME_DATE_FIELDS[assetId] || 'lastInteraction';
  const now = new Date();

  if (frame === 'within_last') {
    const days = parseInt(rule.timeValue, 10);
    if (Number.isNaN(days) || days <= 0) return null;
    const since = new Date(now);
    since.setDate(since.getDate() - days);
    return { [dateField]: { $gte: since } };
  }

  if (frame === 'not_within_last') {
    const days = parseInt(rule.timeValue, 10);
    if (Number.isNaN(days) || days <= 0) return null;
    const before = new Date(now);
    before.setDate(before.getDate() - days);
    return { [dateField]: { $lt: before } };
  }

  if (frame === 'before') {
    const d = parseDateInput(rule.timeValue);
    if (!d) return null;
    return { [dateField]: { $lt: d } };
  }

  if (frame === 'after') {
    const d = parseDateInput(rule.timeValue);
    if (!d) return null;
    return { [dateField]: { $gt: d } };
  }

  if (frame === 'between') {
    const start = parseDateInput(rule.timeValue);
    const end = parseDateInput(rule.timeValueEnd);
    if (!start || !end) return null;
    return { [dateField]: { $gte: start, $lte: end } };
  }

  return null;
}

function mergeClauses(baseClause, extraClause) {
  if (!baseClause || !Object.keys(baseClause).length) return extraClause;
  if (!extraClause || !Object.keys(extraClause).length) return baseClause;
  return { $and: [baseClause, extraClause] };
}

function buildTextMongoClause(field, textOperator, targetValue) {
  const op = String(textOperator || 'equals').toLowerCase();
  const val = String(targetValue ?? '').trim();

  if (op === 'is_set') return { [field]: { $exists: true, $nin: ['', null] } };
  if (op === 'is_not_set') {
    return { $or: [{ [field]: { $exists: false } }, { [field]: '' }, { [field]: null }] };
  }
  if (op === 'contains' && val) {
    return { [field]: { $regex: val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } };
  }
  if (op === 'not_contains' && val) {
    return { [field]: { $not: { $regex: val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } };
  }
  if (op === 'not_equals' && val) return { [field]: { $ne: val } };
  if (val) return { [field]: val };
  return null;
}

function translateRuleToMongo(rule = {}) {
  if (rule.ruleKind === RULE_KINDS.SEGMENT_MEMBERSHIP || rule.segmentId) {
    return null;
  }

  const asset = TRACKABLE_ASSETS.ASSETS[rule.assetId];
  if (!asset) return null;

  let operator = rule.operator;
  let targetValue = rule.targetValue;
  if (rule.frequency && asset.type === 'NUMBER') {
    const mapped = mapFrequencyToOperator(rule.frequency, rule.targetValue);
    operator = mapped.operator;
    targetValue = mapped.targetValue;
  }

  let mongoOperator;
  switch (operator) {
    case '>=': mongoOperator = '$gte'; break;
    case '<=': mongoOperator = '$lte'; break;
    case '===': mongoOperator = '$eq'; break;
    case '!==': mongoOperator = '$ne'; break;
    default: mongoOperator = '$eq';
  }

  let baseClause;

  if (asset.id === 'JUST_LANDED') {
    const isJustLanded = targetValue === true || targetValue === 'true';
    if (isJustLanded) {
      baseClause = { $and: [{ ordersCount: 0 }, { inboundMessageCount: { $lte: 1 } }] };
    } else {
      baseClause = {
        $or: [{ ordersCount: { $gt: 0 } }, { inboundMessageCount: { $gt: 1 } }],
      };
    }
  } else if (asset.type === 'TEXT') {
    baseClause = buildTextMongoClause(asset.dbField, rule.textOperator, targetValue);
  } else if (asset.type === 'CALCULATED_DAYS') {
    const days = parseInt(targetValue, 10);
    if (Number.isNaN(days)) return null;
    const date = new Date();
    date.setDate(date.getDate() - days);
    const dateOp = operator === '>=' ? '$lte' : '$gte';
    baseClause = { [asset.dbField]: { [dateOp]: date } };
  } else if (operator === 'between' && asset.type === 'NUMBER') {
    const start = parseFloat(targetValue);
    const end = parseFloat(rule.targetValueEnd);
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    baseClause = {
      [asset.dbField]: { $gte: Math.min(start, end), $lte: Math.max(start, end) },
    };
  } else {
    let val = targetValue;
    if (asset.type === 'NUMBER' || asset.type === 'COMPUTED_NUMBER') val = parseFloat(targetValue);
    if (asset.type === 'BOOLEAN') val = targetValue === true || targetValue === 'true';
    if (asset.type === 'STRING') val = String(targetValue ?? '').trim();

    if (val === undefined || val === '') return null;
    if ((asset.type === 'NUMBER' || asset.type === 'COMPUTED_NUMBER') && Number.isNaN(val)) return null;

    if (asset.id === 'LEAD_SCORE') {
      baseClause = { leadScore: { [mongoOperator]: val } };
    } else if (asset.id === 'HAS_TAG') {
      baseClause = { tags: { $in: [val] } };
    } else if (asset.id === 'EMAIL_CONSENT') {
      baseClause = { 'channelConsent.email.status': operator === '!==' ? { $ne: val } : val };
    } else if (asset.type === 'STRING' && rule.textOperator) {
      baseClause = buildTextMongoClause(asset.dbField, rule.textOperator, targetValue);
    } else if (asset.type === 'STRING') {
      const field = asset.dbField.includes('.') ? asset.dbField : asset.dbField;
      baseClause = { [field]: operator === '!==' ? { $ne: val } : val };
    } else {
      baseClause = { [asset.dbField]: { [mongoOperator]: val } };
    }
  }

  if (!baseClause) return null;
  const timeClause = buildTimeFrameClause(rule, asset.id);
  return mergeClauses(baseClause, timeClause);
}

function translateTreeToQuery(node) {
  if (!node) return {};
  if (isRuleNode(node)) {
    if (node.ruleKind === RULE_KINDS.SEGMENT_MEMBERSHIP || node.segmentId) return {};
    const clause = translateRuleToMongo(node);
    return clause || {};
  }
  if (!isGroupNode(node)) return {};

  const clauses = (node.children || [])
    .map((child) => translateTreeToQuery(child))
    .filter((c) => c && Object.keys(c).length);

  if (!clauses.length) return {};
  if (clauses.length === 1) return clauses[0];

  const opKey = String(node.operator || 'AND').toUpperCase() === 'OR' ? '$or' : '$and';
  return { [opKey]: clauses };
}

function translateConditionsToQuery(conditionsOrTree) {
  if (conditionsOrTree && isGroupNode(conditionsOrTree)) {
    return translateTreeToQuery(conditionsOrTree);
  }
  if (Array.isArray(conditionsOrTree)) {
    const { flatConditionsToTree } = require('../utils/segmentConditionUtils');
    return translateTreeToQuery(flatConditionsToTree(conditionsOrTree));
  }
  return {};
}

module.exports = {
  translateTreeToQuery,
  translateRuleToMongo,
  translateConditionsToQuery,
  mapFrequencyToOperator,
  buildTimeFrameClause,
  buildTextMongoClause,
};
