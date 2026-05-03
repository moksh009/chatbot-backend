"use strict";

/**
 * Graph button routing — shared by dualBrainEngine (live) and regression scripts.
 * normalizeHandleId strips ReactFlow group/folder prefixes from handle IDs.
 */

function normalizeHandleId(handleId) {
  if (!handleId) return handleId;
  const raw = String(handleId);
  const parts = raw.split("__");
  return parts[parts.length - 1].trim().toLowerCase();
}

/**
 * When the user taps a list/button from an older WhatsApp interactive while
 * `convo.lastStepId` has already moved, only edges from `currentStepId` would
 * match — find the same control id on any interactive/template node in the
 * graph and use its outgoing edge.
 *
 * Tie-break: if multiple nodes expose the same id (e.g. "menu"), prefer the
 * edge whose source node id equals `currentStepId`, else first match.
 */
function findInteractiveEdgeForButtonAcrossGraph(flowNodes, flowEdges, buttonIdRaw, currentStepId) {
  const bid = normalizeHandleId(buttonIdRaw).toLowerCase();
  if (!bid) return null;

  const candidates = [];
  for (const n of flowNodes) {
    if (n.type !== "interactive" && n.type !== "template") continue;
    const buttons = n.data?.buttonsList || [];
    const rows = (n.data?.sections || []).flatMap((s) => s.rows || []);
    const validIds = new Set(
      [...buttons, ...rows]
        .map((b) => normalizeHandleId(b.id).toLowerCase())
        .filter(Boolean)
    );
    if (!validIds.has(bid)) continue;

    const edge = flowEdges.find((e) => {
      if (e.source !== n.id) return false;
      const sid = normalizeHandleId(e.sourceHandle || "").toLowerCase();
      if (sid && sid === bid) return true;
      if (e.trigger?.type === "button") {
        return normalizeHandleId(e.trigger.value || "").toLowerCase() === bid;
      }
      return false;
    });
    if (edge) candidates.push({ nodeId: n.id, edge });
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].edge;

  const onCurrent = candidates.find((c) => c.nodeId === currentStepId);
  if (onCurrent) return onCurrent.edge;

  const toMainMenu = candidates.find((c) => String(c.edge.target || "").includes("main_menu"));
  if ((bid === "menu" || bid === "faq" || bid === "shop" || bid === "track") && toMainMenu) {
    return toMainMenu.edge;
  }

  return candidates[0].edge;
}

module.exports = {
  normalizeHandleId,
  findInteractiveEdgeForButtonAcrossGraph,
};
