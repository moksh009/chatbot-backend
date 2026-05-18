#!/usr/bin/env node
"use strict";

/**
 * Fix Delitech cancel/modify branch:
 * - Remove auto-edge modify → cancel admin alert (caused instant "cancellation received")
 * - Add modify capture → modify alert → modify done path
 * - Order list greeting uses {{first_name}} not wrong Shopify customer name
 *
 * Usage: MONGODB_URI=... node scripts/fixDelitechCancelModifyFlow.js [clientId]
 */

require("dotenv").config();
const connectDB = require("../db");
const WhatsAppFlow = require("../models/WhatsAppFlow");
const { setCachedFlowGraph, invalidateFlowGraphCache } = require("../utils/flowGraphCache");
const { clearTriggerCache } = require("../utils/triggerEngine");

function flowPos(x, y) {
  return { x: x * 280, y: y * 120 };
}

function patchFlow(nodes, edges) {
  const modifyNode = nodes.find(
    (n) => n.id?.includes("can_flow_modify") && n.type === "interactive"
  );
  if (!modifyNode) {
    console.log("  No can_flow_modify node — skip");
    return { nodes, edges, changed: false };
  }

  const suffix = modifyNode.id.replace(/^can_flow_modify_?/, "") || "flow";
  const ids = {
    modCapture: `can_flow_mod_capture_${suffix}`,
    modAlert: `can_flow_mod_alert_${suffix}`,
    modDone: `can_flow_mod_done_${suffix}`,
    alert: nodes.find((n) => n.id?.includes("can_flow_alert"))?.id,
    mainMenu: nodes.find((n) => n.id?.includes("main_menu"))?.id,
  };

  let changed = false;
  const nextEdges = edges.filter((e) => {
    const bad =
      e.source === modifyNode.id &&
      e.target === ids.alert &&
      (!e.sourceHandle || e.sourceHandle === "a" || e.sourceHandle === "output");
    if (bad) {
      changed = true;
      console.log(`  Removed bad edge ${e.id || e.source + "->" + e.target}`);
      return false;
    }
    return true;
  });

  if (!nodes.find((n) => n.id === ids.modCapture)) {
    changed = true;
    nodes.push(
      {
        id: ids.modCapture,
        type: "capture_input",
        position: flowPos(11, 12),
        data: {
          label: "Modify — capture details",
          variable: "modify_details",
          question:
            "✏️ *{{modify_type|Order change}}*\n\nPlease type the updated details for order *{{order_number|your order}}*.",
          text:
            "✏️ *{{modify_type|Order change}}*\n\nPlease type the updated details for order *{{order_number|your order}}*.",
          heatmapCount: 0,
        },
      },
      {
        id: ids.modAlert,
        type: "admin_alert",
        position: flowPos(12, 12),
        data: {
          label: "Modify request — admin",
          priority: "high",
          alertChannel: "both",
          topic: "Modification request — {{order_number}} ({{modify_type}})",
          customMessage:
            "Customer {{customer_name|Unknown}} ({{phone}}) requested a *modification* on *{{order_number}}*.\nType: {{modify_type|Not specified}}\nDetails: {{modify_details|Not provided}}",
          heatmapCount: 0,
        },
      },
      {
        id: ids.modDone,
        type: "message",
        position: flowPos(13, 12),
        data: {
          label: "Modify request received",
          text:
            "✅ *Your modification request has been received.*\n\nOur team will update order *{{order_number|your order}}* and confirm on WhatsApp within *2–4 hours*.",
          heatmapCount: 0,
        },
      }
    );
    console.log("  Added modify capture / alert / done nodes");
  }

  const listNode = nodes.find((n) => n.id?.includes("can_flow_list"));
  if (listNode?.data?.text?.includes("{{customer_name")) {
    listNode.data.text = listNode.data.text.replace(
      /\{\{customer_name/g,
      "{{first_name"
    );
    changed = true;
    console.log("  Order list text now uses {{first_name}}");
  }

  const addEdge = (id, source, target, sourceHandle) => {
    if (!target || nextEdges.some((e) => e.source === source && e.target === target && e.sourceHandle === sourceHandle)) {
      return;
    }
    nextEdges.push({ id, source, target, ...(sourceHandle ? { sourceHandle } : {}) });
    changed = true;
  };

  addEdge(`e_${modifyNode.id}_addr`, modifyNode.id, ids.modCapture, "mod_address");
  addEdge(`e_${modifyNode.id}_phone`, modifyNode.id, ids.modCapture, "mod_phone");
  addEdge(`e_${modifyNode.id}_var`, modifyNode.id, ids.modCapture, "mod_variant");
  addEdge(`e_${modifyNode.id}_oth`, modifyNode.id, ids.modCapture, "mod_other");
  addEdge(`e_${ids.modCapture}_al`, ids.modCapture, ids.modAlert);
  addEdge(`e_${ids.modAlert}_dn`, ids.modAlert, ids.modDone);
  if (ids.mainMenu) {
    addEdge(`e_${ids.modDone}_mm`, ids.modDone, ids.mainMenu);
  }

  return { nodes, edges: nextEdges, changed };
}

async function main() {
  const clientId = process.argv[2] || "delitech_smarthomes";
  await connectDB();

  const flows = await WhatsAppFlow.find({ clientId, status: "PUBLISHED" }).lean();
  if (!flows.length) {
    console.log(`No published flows for ${clientId}`);
    process.exit(0);
  }

  for (const flow of flows) {
    const nodes = JSON.parse(JSON.stringify(flow.publishedNodes || flow.nodes || []));
    const edges = JSON.parse(JSON.stringify(flow.publishedEdges || flow.edges || []));
    console.log(`Patching ${flow.name || flow.flowId}...`);
    const { nodes: n2, edges: e2, changed } = patchFlow(nodes, edges);
    if (!changed) {
      console.log("  Already patched.");
      continue;
    }
    await WhatsAppFlow.updateOne(
      { _id: flow._id },
      { $set: { publishedNodes: n2, nodes: n2, publishedEdges: e2, edges: e2 } }
    );
    invalidateFlowGraphCache(clientId, flow.flowId || String(flow._id));
    setCachedFlowGraph(clientId, flow.flowId || String(flow._id), {
      nodes: n2,
      edges: e2,
      flowId: flow.flowId,
      mongoId: String(flow._id),
      name: flow.name,
    });
    console.log(`  Saved (${n2.length} nodes, ${e2.length} edges)`);
  }

  clearTriggerCache(clientId);
  console.log("Done. Deploy latest backend + run this script on production DB.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
