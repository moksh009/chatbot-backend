#!/usr/bin/env node
/**
 * Structural smoke checks for generated ecommerce flow + stale button routing.
 * Run from repo: node scripts/flowRegressionSmoke.js
 */
"use strict";

const path = require("path");

// eslint-disable-next-line no-unused-vars
const root = path.join(__dirname, "..");
const { generateEcommerceFlow } = require(path.join(root, "utils", "flowGenerator"));
const { findInteractiveEdgeForButtonAcrossGraph } = require(path.join(root, "utils", "graphButtonRouting"));

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

function walkChain(edges, startId, handleSequence) {
  let cur = startId;
  for (const h of handleSequence) {
    const e = edges.find((x) => x.source === cur && (!h || String(x.sourceHandle || "") === h));
    assert(e, `no edge from ${cur} with handle ${h}`);
    cur = e.target;
  }
  return cur;
}

async function main() {
  const client = {
    clientId: "smoke_test_client",
    wizardFeatures: {},
    platformVars: { brandName: "Smoke Brand" },
  };
  const { nodes, edges } = await generateEcommerceFlow(client, {
    businessName: "Smoke Brand",
    preserveNodeIds: true,
  });

  assert(nodes.length > 5 && edges.length > 5, "flow should have nodes and edges");

  const ordTrack = nodes.find((n) => String(n.id).includes("ord_track"));
  const ordHub = nodes.find((n) => String(n.id).includes("ord_hub"));
  const canConfirm = nodes.find((n) => String(n.id).includes("can_confirm"));
  const canLogic = nodes.find((n) => String(n.id).includes("can_logic"));
  const canReason = nodes.find((n) => String(n.id).includes("can_reason"));
  const canAction = nodes.find((n) => String(n.id).includes("can_action"));
  const mainMenu = nodes.find((n) => String(n.id).includes("main_menu"));

  assert(ordTrack && ordHub && canConfirm && canLogic && canReason && canAction && mainMenu, "expected order/cancel nodes present");

  // track → status message → hub (default edge, no handle)
  let cur = ordTrack.id;
  const toStatus = edges.find((e) => e.source === cur && e.sourceHandle === "success");
  assert(toStatus, "ord_track success → status");
  cur = toStatus.target;
  const toHub = edges.find((e) => e.source === cur && e.target === ordHub.id);
  assert(toHub, "status → ord_hub");

  // cancel → confirm → logic (yes)
  cur = walkChain(edges, ordHub.id, ["cancel", "yes", "false"]);
  assert(cur === canReason.id, `expected can_reason after shipped=false, got ${cur}`);

  const toAction = edges.find((e) => e.source === canReason.id);
  assert(toAction && toAction.target === canAction.id, "reason → cancel action");

  // Stale tap: lastStep at main menu, user taps "cancel" from old order hub bubble
  const staleCancel = findInteractiveEdgeForButtonAcrossGraph(nodes, edges, "cancel", mainMenu.id);
  assert(staleCancel && staleCancel.target === canConfirm.id, "cross-step cancel routes to confirm");

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
