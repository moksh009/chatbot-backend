"use strict";

/** Editor-only node types — never executed at runtime */
const EDITOR_ONLY_TYPES = new Set(["sticky", "folder", "group", "comment"]);

function isRuntimeNode(node) {
  if (!node || !node.type) return false;
  if (EDITOR_ONLY_TYPES.has(node.type)) return false;
  if (String(node.id || "").startsWith("note_")) return false;
  return true;
}

/**
 * Keep only nodes reachable from trigger nodes (BFS over edges).
 * Drops orphan canvas nodes and editor stickies/folders from published payloads.
 */
function pruneFlowGraphToReachable(nodes, edges) {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const edgeList = Array.isArray(edges) ? edges : [];
  const byId = new Map(nodeList.map((n) => [n.id, n]));

  const triggers = nodeList.filter(
    (n) => n.type === "trigger" || n.type === "TriggerNode"
  );
  const seeds = triggers.length
    ? triggers.map((t) => t.id)
    : nodeList.filter(isRuntimeNode).map((n) => n.id);

  const reachable = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const id = queue.shift();
    if (!id || reachable.has(id)) continue;
    if (!byId.has(id)) continue;
    reachable.add(id);
    for (const e of edgeList) {
      if (e.source === id && e.target && !reachable.has(e.target)) {
        queue.push(e.target);
      }
    }
  }

  // Always retain folder nodes if they parent reachable children (editor layout)
  const prunedNodes = nodeList.filter((n) => {
    if (n.type === "folder" || n.type === "group") {
      const children = n.children || n.data?.nodes || n.nodes || [];
      return Array.isArray(children) && children.some((c) => reachable.has(c.id));
    }
    return reachable.has(n.id) || (isRuntimeNode(n) && triggers.length === 0);
  });

  const keptIds = new Set(prunedNodes.map((n) => n.id));
  const prunedEdges = edgeList.filter(
    (e) => keptIds.has(e.source) && keptIds.has(e.target)
  );

  return {
    nodes: prunedNodes,
    edges: prunedEdges,
    stats: {
      beforeNodes: nodeList.length,
      afterNodes: prunedNodes.length,
      beforeEdges: edgeList.length,
      afterEdges: prunedEdges.length,
      removedNodes: nodeList.length - prunedNodes.length,
    },
  };
}

/** Strip editor-only nodes from a graph before publish/sync (folders kept for canvas). */
function stripEditorOnlyNodes(nodes, edges) {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const kept = nodeList.filter((n) => {
    if (EDITOR_ONLY_TYPES.has(n.type)) return n.type === "folder" || n.type === "group";
    if (String(n.id || "").startsWith("note_")) return false;
    return true;
  });
  const keptIds = new Set(kept.map((n) => n.id));
  const keptEdges = (Array.isArray(edges) ? edges : []).filter(
    (e) => keptIds.has(e.source) && keptIds.has(e.target)
  );
  return { nodes: kept, edges: keptEdges };
}

module.exports = {
  isRuntimeNode,
  pruneFlowGraphToReachable,
  stripEditorOnlyNodes,
  EDITOR_ONLY_TYPES,
};
