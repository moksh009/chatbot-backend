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
  assert(hasErrorCode(reviewBad, "REVIEW_BRANCH_MISSING"), "Expected review branch validation error");

  const warrantyBad = preflightValidateFlowGraph({
    ...base,
    nodes: [
      { id: "trigger_1", type: "trigger", data: {} },
      { id: "w_1", type: "warranty_check", data: {} },
      { id: "after", type: "message", data: { text: "after" } },
    ],
    edges: [
      { id: "e1", source: "trigger_1", target: "w_1" },
      { id: "e2", source: "w_1", sourceHandle: "active", target: "after" },
    ],
  });
  assert(hasErrorCode(warrantyBad, "WARRANTY_BRANCH_MISSING"), "Expected warranty branch validation error");

  const good = preflightValidateFlowGraph({
    ...base,
    nodes: [
      { id: "trigger_1", type: "trigger", data: {} },
      { id: "review_1", type: "review", data: {} },
      { id: "w_1", type: "warranty_check", data: {} },
      { id: "a", type: "message", data: { text: "A" } },
      { id: "b", type: "message", data: { text: "B" } },
      { id: "c", type: "message", data: { text: "C" } },
    ],
    edges: [
      { id: "e1", source: "trigger_1", target: "review_1" },
      { id: "e4", source: "review_1", sourceHandle: "positive", target: "w_1" },
      { id: "e5", source: "review_1", sourceHandle: "negative", target: "w_1" },
      { id: "e6", source: "w_1", sourceHandle: "active", target: "a" },
      { id: "e7", source: "w_1", sourceHandle: "expired", target: "b" },
      { id: "e8", source: "w_1", sourceHandle: "none", target: "c" },
    ],
  });
  assert(good.valid === true, "Expected valid graph for review/warranty guards");

  console.log("Flow Preflight Node Guards Smoke Pass");
  console.log("--------------------------------");
  console.log("PASS: Loyalty nodes rejected");
  console.log("PASS: Review node branch validation");
  console.log("PASS: Warranty node branch validation");
  console.log("PASS: Valid graph passes preflight");
  console.log("--------------------------------");
  console.log("All 4 checks passed.");
}

run();
