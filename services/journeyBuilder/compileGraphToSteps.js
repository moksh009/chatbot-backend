'use strict';

const moment = require('moment');
const { JOURNEY_NODE_TYPES, isKnownJourneyNodeType } = require('./journeyNodeContract');

function nodeTypeOf(node) {
  return String(node?.type || node?.data?.nodeType || '').trim();
}

function buildAdjacency(edges = []) {
  const out = new Map();
  for (const e of edges || []) {
    const src = e.source;
    if (!src) continue;
    if (!out.has(src)) out.set(src, []);
    out.get(src).push(e);
  }
  return out;
}

function pickDefaultEdge(edges) {
  if (!edges?.length) return null;
  const def = edges.find((e) => e.sourceHandle === 'default' || !e.sourceHandle);
  return def || edges[0];
}

function normalizeDelayUnit(unit) {
  const raw = String(unit || 'm').toLowerCase().trim();
  if (raw === 'm' || raw === 'min' || raw === 'mins' || raw === 'minute' || raw === 'minutes') return 'm';
  if (raw === 'h' || raw === 'hr' || raw === 'hrs' || raw === 'hour' || raw === 'hours') return 'h';
  if (raw === 'd' || raw === 'day' || raw === 'days') return 'd';
  return 'm';
}

function normalizeDelayValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Compile published journey graph → FollowUpSequence.steps[] (linear V1).
 * @param {object} opts
 * @param {object[]} opts.nodes
 * @param {object[]} opts.edges
 * @param {Date} [opts.anchorTime]
 * @returns {{ steps: object[], warnings: string[], cancelOnReply: boolean }}
 */
function compileGraphToSteps({ nodes = [], edges = [], anchorTime = new Date() }) {
  const warnings = [];
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  const adj = buildAdjacency(edges);

  const trigger = (nodes || []).find((n) => nodeTypeOf(n) === JOURNEY_NODE_TYPES.JOURNEY_TRIGGER);
  if (!trigger) {
    return { steps: [], warnings: ['Missing journey trigger node'], cancelOnReply: true };
  }

  const entryType = trigger?.data?.entryType || 'manual';

  const steps = [];
  let pendingDelay = { value: 0, unit: 'm' };
  let pendingCondition = '';
  let currentId = trigger.id;
  const visited = new Set();
  let currentSendAt = moment(anchorTime);

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const outs = adj.get(currentId) || [];
    const edge = pickDefaultEdge(outs);
    if (!edge?.target) break;

    const node = byId.get(edge.target);
    if (!node) {
      warnings.push(`Dangling edge from ${currentId}`);
      break;
    }

    const type = nodeTypeOf(node);
    if (!isKnownJourneyNodeType(type)) {
      warnings.push(`Unknown node type: ${type}`);
      break;
    }

    if (type === JOURNEY_NODE_TYPES.END) break;

    if (type === JOURNEY_NODE_TYPES.WAIT) {
      const d = node.data || {};
      pendingDelay = {
        value: normalizeDelayValue(d.delayValue ?? d.value ?? 0),
        unit: normalizeDelayUnit(d.delayUnit ?? d.unit ?? 'm'),
      };
      currentId = node.id;
      continue;
    }

    if (type === JOURNEY_NODE_TYPES.CONDITION) {
      pendingCondition = String(node.data?.condition || node.data?.conditionType || '').trim();
      currentId = node.id;
      continue;
    }

    if (type === JOURNEY_NODE_TYPES.SEND_WHATSAPP || type === JOURNEY_NODE_TYPES.SEND_EMAIL) {
      const d = node.data || {};
      const delayValue = pendingDelay.value;
      const delayUnit = pendingDelay.unit;
      pendingDelay = { value: 0, unit: 'm' };

      if (delayValue > 0) {
        currentSendAt = currentSendAt.clone().add(delayValue, delayUnit);
      }

      const step = {
        type: type === JOURNEY_NODE_TYPES.SEND_EMAIL ? 'email' : 'whatsapp',
        delayValue,
        delayUnit,
        sendAt: currentSendAt.toDate(),
        status: 'pending',
        interactionMode: 'none',
        expectedActions: [],
        context: null,
      };

      if (step.type === 'whatsapp') {
        step.templateName = String(d.templateName || '').trim();
        step.templateId = d.templateId || '';
        if (!step.templateName) {
          warnings.push('WhatsApp send node missing template');
        }
        // COD confirm templates use button components — mark awaiting_button
        if (d.codConfirmTemplate === true) {
          step.interactionMode = 'awaiting_button';
          step.expectedActions = ['cod_confirm', 'cod_cancel'];
        }
        if (d.addressVerifyTemplate === true) {
          step.interactionMode = 'awaiting_text';
          step.expectedActions = ['address_text'];
        }
      } else {
        step.subject = String(d.subject || '').trim();
        step.content = String(d.content || d.body || '').trim();
        if (!step.subject || !step.content) {
          warnings.push('Email send node missing subject or body');
        }
      }

      if (pendingCondition) {
        step.condition = pendingCondition;
        pendingCondition = '';
      }

      steps.push(step);
      currentId = node.id;
      continue;
    }

    currentId = node.id;
  }

  if (steps.length === 0) {
    warnings.push('No send steps found in journey graph');
  }

  const cancelOnReply = trigger?.data?.cancelOnReply !== false;

  return { steps, warnings, cancelOnReply };
}

module.exports = {
  compileGraphToSteps,
  nodeTypeOf,
};
