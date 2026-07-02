'use strict';

const OUTCOMES = Object.freeze(['message_sent', 'failed', 'converted']);

function codPrepaidOutcomeCondition(outcome, graphNodeId) {
  const o = String(outcome || '').trim();
  const id = String(graphNodeId || '').trim();
  if (!OUTCOMES.includes(o) || !id) return '';
  return `cod_prepaid_outcome:${o}:${id}`;
}

function parseCodPrepaidOutcomeCondition(condition = '') {
  const raw = String(condition || '').trim();
  const m = /^cod_prepaid_outcome:(message_sent|failed|converted):(.+)$/.exec(raw);
  if (!m) return null;
  return { outcome: m[1], graphNodeId: m[2] };
}

function pickCodPrepaidEdge(edges = [], handle) {
  if (!Array.isArray(edges) || !edges.length) return null;
  const h = String(handle || '').trim();
  return edges.find((e) => String(e.sourceHandle || '') === h) || null;
}

module.exports = {
  OUTCOMES,
  codPrepaidOutcomeCondition,
  parseCodPrepaidOutcomeCondition,
  pickCodPrepaidEdge,
};
