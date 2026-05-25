'use strict';

const mongoose = require('mongoose');
const { ENTITY_WHITELIST } = require('./queryPlanner');

const MODELS = {
  AdLead: require('../../models/AdLead'),
  Order: require('../../models/Order'),
  Campaign: require('../../models/Campaign'),
  Conversation: require('../../models/Conversation'),
  Message: require('../../models/Message'),
  FollowUpSequence: require('../../models/FollowUpSequence'),
};

function buildMatch(clientId, plan) {
  const match = { clientId };
  for (const f of plan.filters || []) {
    const val = f.value;
    switch (f.op) {
      case 'eq':
        match[f.field] = val;
        break;
      case 'neq':
        match[f.field] = { $ne: val };
        break;
      case 'gt':
        match[f.field] = { $gt: val };
        break;
      case 'gte':
        match[f.field] = { $gte: val };
        break;
      case 'lt':
        match[f.field] = { $lt: val };
        break;
      case 'lte':
        match[f.field] = { $lte: val };
        break;
      case 'in':
        match[f.field] = { $in: Array.isArray(val) ? val : [val] };
        break;
      case 'contains':
        match[f.field] = { $regex: String(val), $options: 'i' };
        break;
      default:
        break;
    }
  }
  if (plan.timeRange?.from || plan.timeRange?.to) {
    match.createdAt = {};
    if (plan.timeRange.from) match.createdAt.$gte = new Date(plan.timeRange.from);
    if (plan.timeRange.to) match.createdAt.$lte = new Date(plan.timeRange.to);
  }
  return match;
}

function chartTypeHint(plan, rowCount) {
  if (plan.groupBy && plan.metric === 'count') return 'bar';
  if (plan.timeRange) return 'line';
  if (rowCount <= 5) return 'table';
  return 'table';
}

async function executeQueryPlan(plan, clientId) {
  const spec = ENTITY_WHITELIST[plan.entity];
  const Model = MODELS[spec.model];
  if (!Model) throw new Error('Model unavailable');

  const started = Date.now();
  const pipeline = [{ $match: buildMatch(clientId, plan) }];

  const metric = plan.metric || 'count';
  const field = plan.metricField;

  if (plan.groupBy) {
    const groupId = `$${plan.groupBy}`;
    const accum = {};
    if (metric === 'count') accum.value = { $sum: 1 };
    else if (metric === 'sum') accum.value = { $sum: `$${field}` };
    else if (metric === 'avg') accum.value = { $avg: `$${field}` };
    else if (metric === 'min') accum.value = { $min: `$${field}` };
    else if (metric === 'max') accum.value = { $max: `$${field}` };
    else if (metric === 'distinct') accum.value = { $addToSet: `$${field}` };

    pipeline.push({ $group: { _id: groupId, ...accum } });
    if (plan.sort?.field) {
      pipeline.push({ $sort: { [plan.sort.field === 'value' ? 'value' : '_id']: plan.sort.dir === 'desc' ? -1 : 1 } });
    }
    pipeline.push({ $limit: plan.limit });
  } else {
    if (metric === 'count') {
      pipeline.push({ $count: 'value' });
    } else {
      const accum = {};
      if (metric === 'sum') accum.value = { $sum: `$${field}` };
      if (metric === 'avg') accum.value = { $avg: `$${field}` };
      if (metric === 'min') accum.value = { $min: `$${field}` };
      if (metric === 'max') accum.value = { $max: `$${field}` };
      pipeline.push({ $group: { _id: null, ...accum } });
    }
  }

  const rows = await Model.aggregate(pipeline).option({ maxTimeMS: 10000 });
  const executionMs = Date.now() - started;
  const normalized = rows.map((r) => ({
    label: r._id != null ? String(r._id) : 'total',
    value: r.value ?? r.count ?? 0,
  }));

  return {
    rows: normalized,
    totalCount: normalized.length,
    executionMs,
    chartTypeHint: chartTypeHint(plan, normalized.length),
  };
}

module.exports = { executeQueryPlan, buildMatch };
