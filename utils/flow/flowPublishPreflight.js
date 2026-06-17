const { normalizeNodeType } = require('./flowNodeContract');
const { validateFlowNode } = require('../core/validator');
const { lintCopyInFlow } = require('./flowCopyLint');
const { analyzeFlowGraph } = require('./flowStaticAnalysis');
const { findWarrantyOutputEdge } = require('../commerce/warrantyFlowLookup');

const WARRANTY_LEGACY_HANDLES = new Set(['active', 'expired', 'none']);

function isWarrantyNodeType(type) {
  const t = normalizeNodeType(type);
  return t === 'warranty_check' || t === 'warranty_lookup';
}

/**
 * Publish-time cleanup: strip legacy active/expired/none edges from warranty nodes.
 */
function migrateWarrantyFlowGraph({ nodes = [], edges = [] } = {}) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeEdges = Array.isArray(edges) ? edges : [];
  const warrantyIds = new Set(
    safeNodes.filter((n) => isWarrantyNodeType(n?.type)).map((n) => n.id).filter(Boolean)
  );
  if (!warrantyIds.size) {
    return { nodes: safeNodes, edges: safeEdges, warnings: [] };
  }

  const warnings = [];
  const nextEdges = [];
  for (const edge of safeEdges) {
    if (!edge?.source || !warrantyIds.has(edge.source)) {
      nextEdges.push(edge);
      continue;
    }
    const handle = String(edge.sourceHandle || '').toLowerCase();
    if (WARRANTY_LEGACY_HANDLES.has(handle)) {
      warnings.push({
        code: 'WARRANTY_LEGACY_BRANCHES_STRIPPED',
        message: `Removed legacy "${handle}" branch from Warranty Lookup node "${edge.source}".`,
        fix: 'Connect the bottom output to the node that runs after Menu.',
        edgeId: edge.id,
        nodeId: edge.source,
      });
      continue;
    }
    nextEdges.push(edge);
  }

  return { nodes: safeNodes, edges: nextEdges, warnings };
}

function preflightValidateFlowGraph({ nodes = [], edges = [], client }) {
  const errors = [];
  const warnings = [];

  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeEdges = Array.isArray(edges) ? edges : [];

  const idSet = new Set(safeNodes.map((n) => n && n.id).filter(Boolean));
  if (idSet.size !== safeNodes.length) {
    errors.push({
      code: 'FLOW_DUPLICATE_NODE_IDS',
      message: 'Flow has duplicate or missing node IDs.',
      fix: 'Ensure every node has a unique id.'
    });
  }

  const triggerNodes = safeNodes.filter((n) => normalizeNodeType(n?.type) === 'trigger');
  if (triggerNodes.length < 1) {
    errors.push({
      code: 'FLOW_TRIGGER_COUNT',
      message: `Flow must have at least 1 trigger node, found ${triggerNodes.length}.`,
      fix: 'Add at least one entry trigger node.'
    });
  } else if (triggerNodes.length > 1) {
    warnings.push({
      code: 'FLOW_MULTIPLE_TRIGGERS',
      message: `Flow contains ${triggerNodes.length} trigger nodes.`,
      fix: 'This is valid for multi-entry automations. Ensure each trigger maps to a deliberate branch.'
    });
  }

  safeEdges.forEach((e, idx) => {
    if (!e || !e.source || !e.target) {
      errors.push({
        code: 'FLOW_INVALID_EDGE',
        message: `Edge ${e?.id || idx} missing source/target.`,
        fix: 'Reconnect nodes so every edge has a source and target.'
      });
      return;
    }
    if (!idSet.has(e.source) || !idSet.has(e.target)) {
      errors.push({
        code: 'FLOW_EDGE_NODE_MISSING',
        message: `Edge ${e.id || idx} references missing node(s).`,
        fix: 'Remove the edge or restore the referenced node.'
      });
    }
  });

  const outgoingBySource = new Map();
  safeEdges.forEach((e) => {
    if (!e?.source) return;
    const list = outgoingBySource.get(e.source) || [];
    list.push(e);
    outgoingBySource.set(e.source, list);
  });

  const hasHandle = (nodeId, handleId) =>
    (outgoingBySource.get(nodeId) || []).some((e) => String(e.sourceHandle || '') === String(handleId));

  const graphAnalysis = analyzeFlowGraph({ nodes: safeNodes, edges: safeEdges });
  if (graphAnalysis.unreachable.size > 0) {
    warnings.push({
      code: 'FLOW_UNREACHABLE_NODES',
      message: `${graphAnalysis.unreachable.size} node(s) are unreachable from the trigger.`,
      fix: 'Connect these nodes into the main path or remove them.',
      nodeIds: Array.from(graphAnalysis.unreachable).slice(0, 25),
    });
  }
  if (graphAnalysis.deadEnds.size > 0) {
    warnings.push({
      code: 'FLOW_DEAD_ENDS',
      message: `${graphAnalysis.deadEnds.size} reachable node(s) have no outgoing edges (dead ends).`,
      fix: 'Add edges so the conversation can continue (e.g., route back to menu or next step).',
      nodeIds: Array.from(graphAnalysis.deadEnds).slice(0, 25),
    });
  }

  // Node-level validation (templates, interactivity limits, captures, etc.)
  safeNodes.forEach((node) => {
    const res = validateFlowNode(node, client);
    if (res?.errors?.length) errors.push(...res.errors);
    if (res?.warnings?.length) warnings.push(...res.warnings);

    const type = normalizeNodeType(node?.type);
    if (type === 'review') {
      if (!hasHandle(node.id, 'positive') || !hasHandle(node.id, 'negative')) {
        errors.push({
          code: 'REVIEW_BRANCH_MISSING',
          message: `Review node "${node?.id || ''}" requires both positive and negative branches.`,
          fix: 'Connect both positive and negative handles to downstream nodes.'
        });
      }
    }

    if (type === 'loyalty_action' || type === 'loyalty') {
      errors.push({
        code: 'LOYALTY_NODE_REMOVED',
        message: `Loyalty node "${node?.id || ''}" is no longer supported.`,
        fix: 'Delete this node and reconnect the flow.',
      });
    }

    if (type === 'warranty_check' || type === 'warranty_lookup') {
      const outEdges = outgoingBySource.get(node.id) || [];
      const legacyEdges = outEdges.filter((e) =>
        WARRANTY_LEGACY_HANDLES.has(String(e.sourceHandle || '').toLowerCase())
      );
      if (legacyEdges.length > 0) {
        warnings.push({
          code: 'WARRANTY_LEGACY_BRANCHES',
          message: `Warranty Lookup node "${node?.id || ''}" still has legacy active/expired/none branches.`,
          fix: 'Remove legacy branch wires and connect only the bottom output to the node that runs after Menu.',
        });
      }
      if (!findWarrantyOutputEdge(safeEdges, node.id)) {
        errors.push({
          code: 'WARRANTY_OUTPUT_MISSING',
          message: `Warranty Lookup node "${node?.id || ''}" needs one bottom output connected (e.g. main menu).`,
          fix: 'Connect the bottom output handle to the node that should run after the warranty interaction ends.',
        });
      }
    }
  });

  const copyLint = lintCopyInFlow({ nodes: safeNodes });
  if (copyLint?.warnings?.length) warnings.push(...copyLint.warnings);

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { preflightValidateFlowGraph, migrateWarrantyFlowGraph };

