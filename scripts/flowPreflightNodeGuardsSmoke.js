#!/usr/bin/env node
"use strict";

const { preflightValidateFlowGraph } = require('../utils/flow/flowPublishPreflight');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hasErrorCode(result, code) {
  return Array.isArray(result?.errors) && result.errors.some((e) => e?.code === code);
}

function run() {
  const base = {
    nodes: [
      { id: "trigger_1", type: "trigger", data: {} },
      { id: "node_x", type: "message", data: { text: "Hello" } },
    ],
    edges: [{ id: "e1", source: "trigger_1", target: "node_x" }],
    client: { syncedMetaTemplates: [] },
  };

  const loyaltyBad = preflightValidateFlowGraph({
    ...base,
    nodes: [
      { id: "trigger_1", type: "trigger", data: {} },
      { id: "loyalty_1", type: "loyalty_action", data: { actionType: "REDEEM_POINTS", pointsRequired: 100 } },
      { id: "after", type: "message", data: { text: "after" } },
    ],
    edges: [{ id: "e1", source: "trigger_1", target: "loyalty_1" }],
  });
  assert(hasErrorCode(loyaltyBad, "LOYALTY_NODE_REMOVED"), "Expected loyalty node removed error");

  const reviewBad = preflightValidateFlowGraph({
    ...base,
    nodes: [
      { id: "trigger_1", type: "trigger", data: {} },
      { id: "review_1", type: "review", data: {} },
      { id: "after", type: "message", data: { text: "after" } },
    ],
    edges: [
      { id: "e1", source: "trigger_1", target: "review_1" },
      { id: "e2", source: "review_1", sourceHandle: "positive", target: "after" },
    ],
  });
  assert(hasErrorCode(reviewBad, "V1_FORBIDDEN_TYPE"), "Expected V1 forbidden type for review");

  const paymentBad = preflightValidateFlowGraph({
    ...base,
    nodes: [
      { id: "trigger_1", type: "trigger", data: {} },
      { id: "pay_1", type: "payment_link", data: {} },
      { id: "after", type: "message", data: { text: "after" } },
    ],
    edges: [{ id: "e1", source: "trigger_1", target: "pay_1" }],
  });
  assert(hasErrorCode(paymentBad, "V1_FORBIDDEN_TYPE"), "Expected V1 forbidden type for payment_link");
  assert(
    paymentBad.errors.some((e) => e.severity === "block"),
    "Expected V1 forbidden errors to be tier block"
  );

  const warrantyBad = preflightValidateFlowGraph({
    ...base,
    nodes: [
      { id: "trigger_1", type: "trigger", data: {} },
      { id: "w_1", type: "warranty_check", data: {} },
      { id: "after", type: "message", data: { text: "after" } },
    ],
    edges: [
      { id: "e1", source: "trigger_1", target: "w_1" },
    ],
  });
  assert(hasErrorCode(warrantyBad, "WARRANTY_OUTPUT_MISSING"), "Expected warranty output validation error");

  const warrantyLegacyOnly = preflightValidateFlowGraph({
    ...base,
    nodes: [
      { id: "trigger_1", type: "trigger", data: {} },
      { id: "w_1", type: "warranty_check", data: {} },
      { id: "w_active", type: "message", data: { text: "active" } },
      { id: "w_exp", type: "message", data: { text: "expired" } },
      { id: "w_none", type: "message", data: { text: "none" } },
    ],
    edges: [
      { id: "e1", source: "trigger_1", target: "w_1" },
      { id: "e2", source: "w_1", sourceHandle: "active", target: "w_active" },
      { id: "e3", source: "w_1", sourceHandle: "expired", target: "w_exp" },
      { id: "e4", source: "w_1", sourceHandle: "none", target: "w_none" },
    ],
  });
  assert(
    hasErrorCode(warrantyLegacyOnly, "WARRANTY_OUTPUT_MISSING"),
    "Expected warranty legacy-only edges to fail without bottom output"
  );

  const good = preflightValidateFlowGraph({
    ...base,
    nodes: [
      { id: "trigger_1", type: "trigger", data: {} },
      { id: "w_1", type: "warranty_check", data: {} },
      { id: "menu", type: "message", data: { text: "Menu" } },
    ],
    edges: [
      { id: "e1", source: "trigger_1", target: "w_1" },
      { id: "e6", source: "w_1", sourceHandle: "bottom", target: "menu" },
    ],
  });
  assert(good.valid === true, "Expected valid graph for warranty guards");

  console.log("Flow Preflight Node Guards Smoke Pass");
  console.log("--------------------------------");
  console.log("PASS: Loyalty nodes rejected");
  console.log("PASS: V1 forbidden types blocked (review, payment_link)");
  console.log("PASS: Warranty node output validation");
  console.log("PASS: Valid graph passes preflight");
  console.log("--------------------------------");
  console.log("PASS: Warranty legacy-only edges rejected");
  console.log("--------------------------------");
  console.log("All 6 checks passed.");
}

run();
