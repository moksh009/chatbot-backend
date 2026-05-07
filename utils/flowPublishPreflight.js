const { normalizeNodeType } = require('./flowNodeContract');
const { validateFlowNode } = require('./validator');
const { lintCopyInFlow } = require('./flowCopyLint');
const { analyzeFlowGraph } = require('./flowStaticAnalysis');

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
  if (triggerNodes.length !== 1) {
    errors.push({
      code: 'FLOW_TRIGGER_COUNT',
      message: `Flow must have exactly 1 trigger node, found ${triggerNodes.length}.`,
      fix: 'Add exactly one entry trigger node and remove extras.'
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
  });

  const copyLint = lintCopyInFlow({ nodes: safeNodes });
  if (copyLint?.warnings?.length) warnings.push(...copyLint.warnings);

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { preflightValidateFlowGraph };

