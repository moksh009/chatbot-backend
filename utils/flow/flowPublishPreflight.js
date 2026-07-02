const { normalizeNodeType, isV1ForbiddenNodeType } = require('./flowNodeContract');
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
    const type = normalizeNodeType(node?.type);

    if (isV1ForbiddenNodeType(type)) {
      errors.push({
        code: 'V1_FORBIDDEN_TYPE',
        severity: 'block',
        nodeId: node.id,
        message: `Node type "${type}" is not supported in V1 (node "${node?.id || ''}").`,
        fix: 'Remove this node before publishing.',
      });
      return;
    }

    const res = validateFlowNode(node, client);
    if (res?.errors?.length) errors.push(...res.errors);
    if (res?.warnings?.length) warnings.push(...res.warnings);

    if (type === 'review') {
      if (!hasHandle(node.id, 'positive') || !hasHandle(node.id, 'negative')) {
        errors.push({
          code: 'REVIEW_BRANCH_MISSING',
          message: `Review node "${node?.id || ''}" requires both positive and negative branches.`,
          fix: 'Connect both positive and negative handles to downstream nodes.'
        });
      }
    }

    if (type === 'cod_prepaid' || type === 'cod_to_prepaid') {
      if (!hasHandle(node.id, 'paid') && !hasHandle(node.id, 'cod')) {
        warnings.push({
          code: 'COD_PREPAID_BRANCHES_MISSING',
          message: `COD → prepaid node "${node?.id || ''}" has no paid or cod branch wired.`,
          fix: 'Connect **paid** (after conversion) and **cod** (declined) handles.'
        });
      }
    }

    if (type === 'delay') {
      warnings.push({
        code: 'DELAY_REQUIRES_CRON',
        message: `Delay node "${node?.id || ''}" pauses until flowResumptionCron runs (worker with RUN_CRONS=true).`,
        fix: 'Ensure worker service is deployed; simulator skips delay after 1s.'
      });
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

    if (type === 'shopify_call') {
      const ORDER_LOOKUP_ACTIONS = new Set(['CHECK_ORDER_STATUS', 'ORDER_STATUS', 'get_order']);
      const allowed = new Set([...ORDER_LOOKUP_ACTIONS, 'search_products', 'get_latest', 'GET_CUSTOMER_ORDERS', 'UPDATE_ORDER_ADDRESS', 'PRODUCT_CARD']);
      const action = String(node.data?.action || 'CHECK_ORDER_STATUS').trim();
      if (!allowed.has(action)) {
        errors.push({
          code: 'SHOPIFY_ACTION_INVALID',
          nodeId: node.id,
          message: `Shopify node "${node?.id || ''}" uses unsupported action "${action}".`,
          fix: 'Use Fetch Latest Order (CHECK_ORDER_STATUS) or re-open the flow to auto-migrate legacy nodes.',
        });
      }
      const outs = outgoingBySource.get(node.id) || [];
      const hasOrderLookupWiring = outs.some((e) =>
        ['success', 'no_order', 'not_found', 'error'].includes(String(e.sourceHandle || '').toLowerCase())
      );
      const hasMessageBody = Boolean(String(node.data?.messageBody || '').trim());
      if (action === 'search_products' && (hasOrderLookupWiring || hasMessageBody)) {
        warnings.push({
          code: 'SHOPIFY_ACTION_ORDER_LOOKUP_MISMATCH',
          nodeId: node.id,
          message: `Shopify node "${node?.id || ''}" is wired for order lookup but action is still "search_products".`,
          fix: 'Re-open the flow in studio to auto-migrate, or set action to CHECK_ORDER_STATUS before publish.',
        });
      }
      if (ORDER_LOOKUP_ACTIONS.has(action)) {
        const out = outgoingBySource.get(node.id) || [];
        const hasFail = out.some((e) =>
          ['no_order', 'not_found', 'error'].includes(String(e.sourceHandle || '').toLowerCase())
        );
        if (!hasFail) {
          warnings.push({
            code: 'SHOPIFY_ORDER_LOOKUP_NO_FALLBACK',
            nodeId: node.id,
            message: `Shopify latest-order lookup "${node?.id || ''}" has no no_order / not_found / error branch.`,
            fix: 'Connect a friendly message when the customer has no order on file.',
          });
        }
      }
      if (action === 'get_order' && !String(node.data?.query || '').trim()) {
        warnings.push({
          code: 'SHOPIFY_ORDER_ID_EMPTY',
          nodeId: node.id,
          message: `Shopify order-by-ID node "${node?.id || ''}" has no order ID or variable.`,
          fix: 'Set {{order_id}} or add a Capture input step before this node.',
        });
      }
    }
  });

  const copyLint = lintCopyInFlow({ nodes: safeNodes });
  if (copyLint?.warnings?.length) warnings.push(...copyLint.warnings);

  const autoMessageTypes = new Set(['message', 'template', 'image']);
  const warnedChains = new Set();
  for (const node of safeNodes) {
    if (!autoMessageTypes.has(normalizeNodeType(node?.type))) continue;
    let chainLen = 1;
    let curId = node.id;
    const visited = new Set([curId]);
    while (chainLen < 6) {
      const outs = outgoingBySource.get(curId) || [];
      const autoEdge = outs.find(
        (e) =>
          !e.sourceHandle ||
          e.sourceHandle === 'a' ||
          e.sourceHandle === 'bottom' ||
          e.sourceHandle === 'output'
      );
      if (!autoEdge) break;
      const next = safeNodes.find((n) => n.id === autoEdge.target);
      if (!next || visited.has(next.id)) break;
      if (!autoMessageTypes.has(normalizeNodeType(next.type))) break;
      visited.add(next.id);
      curId = next.id;
      chainLen += 1;
    }
    if (chainLen >= 3 && !warnedChains.has(curId)) {
      warnedChains.add(curId);
      warnings.push({
        code: 'FLOW_AUTO_MESSAGE_BURST',
        nodeId: node.id,
        message: `Flow has ${chainLen} message/template steps in a row without Delay or an interactive step.`,
        fix: 'Add a Delay node between bursts, or use Interactive / Capture so customers can reply between messages.',
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { preflightValidateFlowGraph, migrateWarrantyFlowGraph };

