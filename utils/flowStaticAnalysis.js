"use strict";

const { normalizeNodeType } = require("./flowNodeContract");

function analyzeFlowGraph({ nodes = [], edges = [] }) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeEdges = Array.isArray(edges) ? edges : [];

  const nodeById = new Map(safeNodes.filter(Boolean).map((n) => [n.id, n]));
  const out = new Map();
  for (const e of safeEdges) {
    if (!e?.source || !e?.target) continue;
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e);
  }

  const trigger = safeNodes.find((n) => normalizeNodeType(n?.type) === "trigger") || null;
  if (!trigger) {
    return {
      reachable: new Set(),
      unreachable: new Set(safeNodes.map((n) => n.id).filter(Boolean)),
      deadEnds: new Set(),
    };
  }

  const reachable = new Set([trigger.id]);
  const q = [trigger.id];
  while (q.length) {
    const cur = q.shift();
    const outs = out.get(cur) || [];
    for (const e of outs) {
      if (!reachable.has(e.target) && nodeById.has(e.target)) {
        reachable.add(e.target);
        q.push(e.target);
      }
    }
  }

  const unreachable = new Set(
    safeNodes
      .map((n) => n && n.id)
      .filter(Boolean)
      .filter((id) => !reachable.has(id))
  );

  // Dead ends = reachable nodes with no outgoing edges (excluding allowed terminal-ish nodes)
  const terminalOk = new Set(["livechat", "admin_alert", "folder"]);
  const deadEnds = new Set();
  for (const id of reachable) {
    const node = nodeById.get(id);
    if (!node) continue;
    const t = normalizeNodeType(node.type);
    if (terminalOk.has(t)) continue;
    const outs = out.get(id) || [];
    if (outs.length === 0) deadEnds.add(id);
  }

  return { reachable, unreachable, deadEnds };
}

module.exports = { analyzeFlowGraph };

