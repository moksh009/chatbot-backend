'use strict';

const { platformGenerateJSON } = require('../../utils/core/gemini');

const ENTITY_WHITELIST = {
  leads: {
    model: 'AdLead',
    fields: ['leadScore', 'intentState', 'cartStatus', 'createdAt', 'lastActivityAt', 'conversionProbability'],
    metrics: ['count', 'avg', 'min', 'max', 'distinct'],
  },
  orders: {
    model: 'Order',
    fields: ['amount', 'status', 'storeKey', 'createdAt', 'paymentMethod'],
    metrics: ['count', 'sum', 'avg', 'min', 'max'],
  },
  campaigns: {
    model: 'Campaign',
    fields: ['status', 'channel', 'createdAt', 'recipientCount', 'sentCount'],
    metrics: ['count', 'sum', 'avg'],
  },
  conversations: {
    model: 'Conversation',
    fields: ['status', 'channel', 'sentiment', 'createdAt', 'lastMessageAt'],
    metrics: ['count', 'distinct'],
  },
  messages: {
    model: 'Message',
    fields: ['direction', 'createdAt', 'channel'],
    metrics: ['count'],
  },
  sequences: {
    model: 'FollowUpSequence',
    fields: ['status', 'type', 'createdAt'],
    metrics: ['count'],
  },
};

const OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']);

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('Invalid query plan');
  const entity = plan.entity;
  const spec = ENTITY_WHITELIST[entity];
  if (!spec) throw new Error(`Entity not allowed: ${entity}`);

  const metric = plan.metric || 'count';
  if (!spec.metrics.includes(metric)) throw new Error(`Metric not allowed for ${entity}: ${metric}`);

  if (plan.metricField && !spec.fields.includes(plan.metricField)) {
    throw new Error(`Field not allowed: ${plan.metricField}`);
  }

  for (const f of plan.filters || []) {
    if (!spec.fields.includes(f.field) && f.field !== 'clientId') {
      throw new Error(`Filter field not allowed: ${f.field}`);
    }
    if (!OPS.has(f.op)) throw new Error(`Operator not allowed: ${f.op}`);
  }

  if (plan.groupBy && !spec.fields.includes(plan.groupBy)) {
    throw new Error(`groupBy not allowed: ${plan.groupBy}`);
  }

  plan.limit = Math.min(Math.max(Number(plan.limit) || 50, 1), 200);
  return plan;
}

async function planQuery(naturalLanguage, clientId) {
  const entities = Object.keys(ENTITY_WHITELIST).join(', ');
  const prompt = `You are a BI query planner. Output ONLY JSON matching this schema:
{
  "entity": one of [${entities}],
  "filters": [{ "field": "...", "op": "eq|neq|gt|gte|lt|lte|in|contains", "value": ... }],
  "groupBy": string or null,
  "metric": "count|sum|avg|min|max|distinct",
  "metricField": string or null,
  "timeRange": { "from": "ISO date", "to": "ISO date" } or null,
  "limit": number <= 200,
  "sort": { "field": "...", "dir": "asc|desc" } or null
}
Do NOT include clientId. Question: ${naturalLanguage}`;

  let raw;
  try {
    raw = await platformGenerateJSON({ clientId, purpose: 'bi_query_plan', prompt });
  } catch {
    raw = null;
  }

  if (!raw?.entity) {
    const lower = naturalLanguage.toLowerCase();
    if (lower.includes('order')) {
      raw = { entity: 'orders', metric: 'sum', metricField: 'amount', filters: [], limit: 50 };
    } else if (lower.includes('campaign')) {
      raw = { entity: 'campaigns', metric: 'count', filters: [], limit: 50 };
    } else {
      raw = { entity: 'leads', metric: 'count', filters: [], limit: 50 };
    }
  }

  return validatePlan(raw);
}

module.exports = { planQuery, validatePlan, ENTITY_WHITELIST };
