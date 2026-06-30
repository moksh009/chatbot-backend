'use strict';

const moment = require('moment');
const { JOURNEY_NODE_TYPES, isKnownJourneyNodeType } = require('./journeyNodeContract');
const { branchRuleToGates } = require('./branchRuleGates');

function nodeTypeOf(node) {
  return String(node?.type || node?.data?.nodeType || '').trim();
}

function isBranchNodeType(type) {
  return type === JOURNEY_NODE_TYPES.CONDITION || type === JOURNEY_NODE_TYPES.CONDITIONAL_SPLIT;
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

function pickLinearEdge(edges = []) {
  if (!edges?.length) return null;
  const def = edges.find((e) => e.sourceHandle === 'default' || !e.sourceHandle);
  return def || edges[0];
}

function pickBranchEdge(edges = [], polarity = 'yes') {
  if (!edges?.length) return null;
  if (polarity === 'yes') {
    return edges.find((e) => e.sourceHandle === 'yes' || e.sourceHandle === 'a') || null;
  }
  return edges.find((e) => e.sourceHandle === 'no' || e.sourceHandle === 'b') || null;
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

function mergeStepsBySendAt(yesSteps = [], noSteps = []) {
  const tagged = [
    ...yesSteps.map((s) => ({ ...s, __path: 'yes' })),
    ...noSteps.map((s) => ({ ...s, __path: 'no' })),
  ];
  tagged.sort((a, b) => {
    const ta = new Date(a.sendAt).getTime();
    const tb = new Date(b.sendAt).getTime();
    if (ta !== tb) return ta - tb;
    if (a.__path === b.__path) return 0;
    return a.__path === 'yes' ? -1 : 1;
  });
  return tagged.map(({ __path, ...step }) => step);
}

function buildSendStep(node, type, ctx) {
  const d = node.data || {};
  const delayValue = ctx.pendingDelay.value;
  const delayUnit = ctx.pendingDelay.unit;
  ctx.pendingDelay = { value: 0, unit: 'm' };

  if (delayValue > 0) {
    ctx.currentSendAt = ctx.currentSendAt.clone().add(delayValue, delayUnit);
  }

  const step = {
    type: type === JOURNEY_NODE_TYPES.SEND_EMAIL ? 'email' : 'whatsapp',
    delayValue,
    delayUnit,
    sendAt: ctx.currentSendAt.toDate(),
    status: 'pending',
    interactionMode: 'none',
    expectedActions: [],
    context: null,
  };

  if (step.type === 'whatsapp') {
    step.templateName = String(d.templateName || '').trim();
    step.templateId = d.templateId || '';
    const vmRaw = d.variableMappings && typeof d.variableMappings === 'object' ? d.variableMappings : {};
    const vm = { ...vmRaw, body: vmRaw.body && typeof vmRaw.body === 'object' ? { ...vmRaw.body } : {} };
    let body = { ...(vm.body || {}) };
    if (!Object.keys(body).length) {
      Object.entries(vmRaw).forEach(([k, v]) => {
        if (/^\d+$/.test(String(k)) && v != null && v !== '') body[String(k)] = String(v);
      });
    }
    if (d.buttonMappings && typeof d.buttonMappings === 'object' && !vm.buttons) {
      vm.buttons = { ...d.buttonMappings };
    }
    if (d.headerImageField && !vm.header) {
      vm.header = d.headerImageField;
    }
    if (Object.keys(body).length) {
      step.variableMapping = { ...body };
      step.variableMappings = {
        body: { ...body },
        ...(vm.header ? { header: vm.header } : d.headerImageField ? { header: d.headerImageField } : {}),
        ...(vm.buttons ? { buttons: { ...vm.buttons } } : {}),
      };
    } else if (d.buttonMappings && typeof d.buttonMappings === 'object') {
      step.variableMappings = { body: {}, buttons: { ...d.buttonMappings } };
    }
    const custom = d.customVariableValues || d.customValues;
    if (custom && typeof custom === 'object' && Object.keys(custom).length) {
      step.customVariableValues = { ...custom };
    }
    if (!step.templateName) {
      ctx.warnings.push('WhatsApp send node missing template');
    }
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
      ctx.warnings.push('Email send node missing subject or body');
    }
  }

  const gate = ctx.inheritedGate || ctx.pendingCondition;
  if (gate) {
    step.condition = gate;
    ctx.pendingCondition = '';
  }

  return step;
}

function buildHandoffStep(node, ctx) {
  const d = node.data || {};
  const delayValue = ctx.pendingDelay.value;
  const delayUnit = ctx.pendingDelay.unit;
  ctx.pendingDelay = { value: 0, unit: 'm' };

  if (delayValue > 0) {
    ctx.currentSendAt = ctx.currentSendAt.clone().add(delayValue, delayUnit);
  }

  const step = {
    type: 'flow_handoff',
    targetFlowId: String(d.targetFlowId || '').trim(),
    targetFlowName: String(d.targetFlowName || '').trim(),
    delayValue,
    delayUnit,
    sendAt: ctx.currentSendAt.toDate(),
    status: 'pending',
    interactionMode: 'none',
    expectedActions: [],
    context: { handoff: true },
  };

  const gate = ctx.inheritedGate || ctx.pendingCondition;
  if (gate) {
    step.condition = gate;
    ctx.pendingCondition = '';
  }

  if (!step.targetFlowId) {
    ctx.warnings.push('Connect to Chatbot node missing target flow');
  }

  return step;
}

/**
 * Linear walk from startNodeId until END. Tags actionable steps with inheritedGate.
 */
function compileSubtree(startNodeId, byId, adj, ctx) {
  const steps = [];
  const visited = new Set();
  let currentId = startNodeId;
  const localCtx = {
    ...ctx,
    pendingDelay: { ...ctx.pendingDelay },
    pendingCondition: ctx.pendingCondition || '',
    currentSendAt: ctx.currentSendAt.clone(),
    inheritedGate: ctx.inheritedGate || '',
  };

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = byId.get(currentId);
    if (!node) {
      localCtx.warnings.push(`Dangling edge target: ${currentId}`);
      break;
    }

    const type = nodeTypeOf(node);
    if (!isKnownJourneyNodeType(type)) {
      localCtx.warnings.push(`Unknown node type: ${type}`);
      break;
    }

    if (type === JOURNEY_NODE_TYPES.END) break;

    if (type === JOURNEY_NODE_TYPES.WAIT) {
      const d = node.data || {};
      localCtx.pendingDelay = {
        value: normalizeDelayValue(d.delayValue ?? d.value ?? 0),
        unit: normalizeDelayUnit(d.delayUnit ?? d.unit ?? 'm'),
      };
      const outs = adj.get(currentId) || [];
      const edge = pickLinearEdge(outs);
      if (!edge?.target) break;
      currentId = edge.target;
      continue;
    }

    if (isBranchNodeType(type)) {
      localCtx.warnings.push('Nested branch nodes are not supported in V1 — only Yes path compiled from nested branch');
      const outs = adj.get(currentId) || [];
      const yesEdge = pickBranchEdge(outs, 'yes');
      if (!yesEdge?.target) break;
      const nested = compileSubtree(yesEdge.target, byId, adj, {
        ...localCtx,
        inheritedGate: branchRuleToGates(node.data || {}).yesGate,
      });
      steps.push(...nested.steps);
      break;
    }

    if (type === JOURNEY_NODE_TYPES.CHATBOT_HANDOFF) {
      steps.push(buildHandoffStep(node, localCtx));
      const outs = adj.get(currentId) || [];
      const edge = pickLinearEdge(outs);
      if (!edge?.target) break;
      currentId = edge.target;
      continue;
    }

    if (type === JOURNEY_NODE_TYPES.SEND_WHATSAPP || type === JOURNEY_NODE_TYPES.SEND_EMAIL) {
      steps.push(buildSendStep(node, type, localCtx));
      const outs = adj.get(currentId) || [];
      const edge = pickLinearEdge(outs);
      if (!edge?.target) break;
      currentId = edge.target;
      continue;
    }

    const outs = adj.get(currentId) || [];
    const edge = pickLinearEdge(outs);
    if (!edge?.target) break;
    currentId = edge.target;
  }

  return { steps };
}

function compileBranchNode(node, byId, adj, ctx) {
  const outs = adj.get(node.id) || [];
  const yesEdge = pickBranchEdge(outs, 'yes');
  const noEdge = pickBranchEdge(outs, 'no');
  const { yesGate, noGate, isPassthrough } = branchRuleToGates(node.data || {});

  if (isPassthrough) {
    ctx.warnings.push("Branch rule is 'Always continue' — only Yes path compiled");
    if (!yesEdge?.target) {
      ctx.warnings.push('Branch Yes path is not connected');
      return [];
    }
    const yesResult = compileSubtree(yesEdge.target, byId, adj, {
      ...ctx,
      inheritedGate: '',
      pendingCondition: '',
    });
    return yesResult.steps;
  }

  const yesSteps = yesEdge?.target
    ? compileSubtree(yesEdge.target, byId, adj, {
        ...ctx,
        inheritedGate: yesGate,
        pendingCondition: '',
      }).steps
    : [];

  const noSteps = noEdge?.target
    ? compileSubtree(noEdge.target, byId, adj, {
        ...ctx,
        inheritedGate: noGate,
        pendingCondition: '',
      }).steps
    : [];

  if (yesSteps.length && !noEdge?.target) {
    ctx.warnings.push('Branch No path is not connected — only Yes path steps will run');
  }
  if (noSteps.length && !yesEdge?.target) {
    ctx.warnings.push('Branch Yes path is not connected — only No path steps will run');
  }
  if (!yesSteps.length && !noSteps.length) {
    ctx.warnings.push('Branch node has no connected actionable steps');
  }

  return mergeStepsBySendAt(yesSteps, noSteps);
}

/**
 * Compile published journey graph → FollowUpSequence.steps[] (dual-path branch V1).
 */
function compileGraphToSteps({ nodes = [], edges = [], anchorTime = new Date() }) {
  const warnings = [];
  const byId = new Map((nodes || []).map((n) => [n.id, n]));
  const adj = buildAdjacency(edges);

  const trigger = (nodes || []).find((n) => nodeTypeOf(n) === JOURNEY_NODE_TYPES.JOURNEY_TRIGGER);
  if (!trigger) {
    return { steps: [], warnings: ['Missing journey trigger node'], cancelOnReply: true };
  }

  const steps = [];
  let pendingDelay = { value: 0, unit: 'm' };
  let pendingCondition = '';
  let currentId = trigger.id;
  const visited = new Set();
  let currentSendAt = moment(anchorTime);

  const ctxBase = () => ({
    warnings,
    pendingDelay,
    pendingCondition,
    currentSendAt,
    inheritedGate: '',
  });

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const outs = adj.get(currentId) || [];
    const edge = pickLinearEdge(outs);
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

    if (isBranchNodeType(type)) {
      const branchSteps = compileBranchNode(node, byId, adj, {
        ...ctxBase(),
        pendingDelay: { ...pendingDelay },
        pendingCondition,
        currentSendAt: currentSendAt.clone(),
      });
      steps.push(...branchSteps);
      pendingDelay = { value: 0, unit: 'm' };
      pendingCondition = '';
      break;
    }

    if (type === JOURNEY_NODE_TYPES.CHATBOT_HANDOFF) {
      const ctx = {
        ...ctxBase(),
        pendingDelay: { ...pendingDelay },
        pendingCondition,
        currentSendAt: currentSendAt.clone(),
      };
      const step = buildHandoffStep(node, ctx);
      pendingDelay = ctx.pendingDelay;
      pendingCondition = ctx.pendingCondition;
      currentSendAt = ctx.currentSendAt;
      steps.push(step);
      currentId = node.id;
      continue;
    }

    if (type === JOURNEY_NODE_TYPES.SEND_WHATSAPP || type === JOURNEY_NODE_TYPES.SEND_EMAIL) {
      const ctx = {
        ...ctxBase(),
        pendingDelay: { ...pendingDelay },
        pendingCondition,
        currentSendAt: currentSendAt.clone(),
      };
      const step = buildSendStep(node, type, ctx);
      pendingDelay = ctx.pendingDelay;
      pendingCondition = ctx.pendingCondition;
      currentSendAt = ctx.currentSendAt;
      steps.push(step);
      currentId = node.id;
      continue;
    }

    currentId = node.id;
  }

  if (steps.length === 0) {
    warnings.push('No actionable steps found in journey graph');
  }

  const cancelOnReply = trigger?.data?.cancelOnReply !== false;

  return { steps, warnings, cancelOnReply };
}

module.exports = {
  compileGraphToSteps,
  nodeTypeOf,
  compileSubtree,
  mergeStepsBySendAt,
  branchRuleToGates,
};
