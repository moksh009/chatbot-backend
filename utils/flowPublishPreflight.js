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
    if (type === 'loyalty_action') {
      const actionType = String(node?.data?.actionType || 'GIVE_LOYALTY').toUpperCase();
      const pointsRequired = Number(node?.data?.pointsRequired || 0);
      if (actionType === 'REDEEM_POINTS') {
        if (!(pointsRequired > 0)) {
          errors.push({
            code: 'LOYALTY_REDEEM_POINTS_INVALID',
            message: `Loyalty node "${node?.id || ''}" must have pointsRequired > 0.`,
            fix: 'Set a positive pointsRequired in node settings.'
          });
        }
        if (!hasHandle(node.id, 'success') || !hasHandle(node.id, 'fail')) {
          errors.push({
            code: 'LOYALTY_REDEEM_BRANCH_MISSING',
            message: `Loyalty redeem node "${node?.id || ''}" requires both success and fail branches.`,
            fix: 'Connect both success and fail handles to downstream nodes.'
          });
        }
      }
    }

    if (type === 'review') {
      if (!hasHandle(node.id, 'positive') || !hasHandle(node.id, 'negative')) {
        errors.push({
          code: 'REVIEW_BRANCH_MISSING',
          message: `Review node "${node?.id || ''}" requires both positive and negative branches.`,
          fix: 'Connect both positive and negative handles to downstream nodes.'
        });
      }
    }

    if (type === 'warranty_check') {
      const requiredHandles = ['active', 'expired', 'none'];
      const missing = requiredHandles.filter((h) => !hasHandle(node.id, h));
      if (missing.length) {
        errors.push({
          code: 'WARRANTY_BRANCH_MISSING',
          message: `Warranty node "${node?.id || ''}" is missing branch(es): ${missing.join(', ')}.`,
          fix: 'Connect active, expired, and none handles to downstream nodes.'
        });
      }
    }
  });

  const copyLint = lintCopyInFlow({ nodes: safeNodes });
  if (copyLint?.warnings?.length) warnings.push(...copyLint.warnings);

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { preflightValidateFlowGraph };

