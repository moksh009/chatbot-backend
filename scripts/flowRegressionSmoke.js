#!/usr/bin/env node
/**
 * Structural smoke checks for generated ecommerce flow + stale button routing.
 * Run from repo: node scripts/flowRegressionSmoke.js
 */
"use strict";

const path = require("path");

// eslint-disable-next-line no-unused-vars
const root = path.join(__dirname, "..");
const { generateEcommerceFlow } = require(path.join(root, "utils", "flow", "flowGenerator"));
const { findInteractiveEdgeForButtonAcrossGraph } = require(path.join(root, "utils", "flow", "graphButtonRouting"));

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

async function main() {
  const client = {
    clientId: "smoke_test_client",
    wizardFeatures: { enableOrderTracking: true, enableCancelOrder: true },
    platformVars: { brandName: "Smoke Brand" },
  };
  const { nodes, edges } = await generateEcommerceFlow(client, {
    businessName: "Smoke Brand",
    preserveNodeIds: true,
  });

  assert(nodes.length > 5 && edges.length > 5, "flow should have nodes and edges");

  const ordAsk = nodes.find((n) => String(n.id).includes("ord_ask"));
  const ordTrack = nodes.find(
    (n) => String(n.id).includes("ord_track") && !String(n.id).includes("retry")
  );
  const ordStatus = nodes.find((n) => String(n.id).includes("ord_status_msg"));
  const canFlowAsk = nodes.find((n) => String(n.id).includes("can_flow_ask"));
  const canLogic = nodes.find((n) => String(n.id).includes("can_logic"));
  const canReason = nodes.find((n) => String(n.id).includes("can_flow_reason"));
  const canPostCancel =
    nodes.find((n) => String(n.id).includes("can_flow_alert")) ||
    nodes.find((n) => String(n.id).includes("can_flow_done"));
  const mainMenu = nodes.find((n) => String(n.id).includes("main_menu"));

  assert(
    ordAsk &&
      ordTrack &&
      ordStatus &&
      canFlowAsk &&
      canLogic &&
      canReason &&
      canPostCancel &&
      mainMenu,
    "expected order/cancel nodes present"
  );

  // Track: ask → shopify lookup → status message on success
  const askToTrack = edges.find((e) => e.source === ordAsk.id && e.target === ordTrack.id);
  assert(askToTrack, "ord_ask → ord_track");
  const toStatus = edges.find((e) => e.source === ordTrack.id && e.sourceHandle === "success");
  assert(toStatus && toStatus.target === ordStatus.id, "ord_track success → status");

  // Cancel: shipped gate → shipped bubble or choice list
  const toShipped = edges.find((e) => e.source === canLogic.id && e.sourceHandle === "true");
  const toChoice = edges.find((e) => e.source === canLogic.id && e.sourceHandle === "false");
  assert(toShipped && String(toShipped.target).includes("can_flow_shipped"), "can_logic true → shipped");
  assert(toChoice && String(toChoice.target).includes("can_flow_choice"), "can_logic false → choice");

  const toPostCancel = edges.find((e) => e.source === canReason.id);
  assert(toPostCancel && toPostCancel.target === canPostCancel.id, "reason → cancel admin/done");

  // Stale tap: lastStep at main menu, user taps cancel row from an older menu bubble
  const staleCancel = findInteractiveEdgeForButtonAcrossGraph(nodes, edges, "mnu_cancel", mainMenu.id);
  assert(staleCancel && staleCancel.target === canFlowAsk.id, "cross-step mnu_cancel routes to cancel ask");

  const staleMenu = findInteractiveEdgeForButtonAcrossGraph(nodes, edges, "menu", canLogic.id);
  assert(staleMenu && String(staleMenu.target).includes("main_menu"), "cross-step menu reaches main menu");

  const supCapture = nodes.find((n) => String(n.id).includes("sup_capture"));
  const supLivechat = nodes.find((n) => String(n.id).includes("sup_livechat"));
  if (supCapture && supLivechat) {
    const pathToLive = edges.some((e) => e.source === supCapture.id || e.target === supLivechat.id);
    assert(pathToLive, "support branch should reference livechat somewhere in graph");
  }

  console.log("OK flowRegressionSmoke — nodes:", nodes.length, "edges:", edges.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
