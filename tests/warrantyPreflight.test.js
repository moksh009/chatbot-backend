"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  preflightValidateFlowGraph,
  migrateWarrantyFlowGraph,
} = require("../utils/flow/flowPublishPreflight");
const { findWarrantyOutputEdge } = require("../utils/commerce/warrantyFlowLookup");

describe("warranty preflight + migration", () => {
  const base = {
    nodes: [
      { id: "trigger_1", type: "trigger", data: {} },
      { id: "w_1", type: "warranty_check", data: {} },
      { id: "menu", type: "message", data: { text: "Menu" } },
    ],
    edges: [
      { id: "e1", source: "trigger_1", target: "w_1" },
      { id: "e2", source: "w_1", sourceHandle: "bottom", target: "menu" },
    ],
    client: { syncedMetaTemplates: [] },
  };

  it("passes when warranty node has bottom output", () => {
    const result = preflightValidateFlowGraph(base);
    assert.equal(result.valid, true);
    assert.equal(findWarrantyOutputEdge(base.edges, "w_1")?.target, "menu");
  });

  it("fails when only legacy branches are wired", () => {
    const result = preflightValidateFlowGraph({
      ...base,
      nodes: [
        ...base.nodes,
        { id: "w_active", type: "message", data: { text: "a" } },
      ],
      edges: [
        { id: "e1", source: "trigger_1", target: "w_1" },
        { id: "e2", source: "w_1", sourceHandle: "active", target: "w_active" },
      ],
    });
    assert.equal(result.valid, false);
    assert.equal(
      result.errors.some((e) => e.code === "WARRANTY_OUTPUT_MISSING"),
      true
    );
  });

  it("migrateWarrantyFlowGraph strips legacy handles", () => {
    const migrated = migrateWarrantyFlowGraph({
      nodes: base.nodes,
      edges: [
        { id: "e1", source: "trigger_1", target: "w_1" },
        { id: "e2", source: "w_1", sourceHandle: "active", target: "menu" },
        { id: "e3", source: "w_1", sourceHandle: "bottom", target: "menu" },
      ],
    });
    assert.equal(
      migrated.edges.some((e) => e.sourceHandle === "active"),
      false
    );
    assert.equal(
      migrated.edges.some((e) => e.sourceHandle === "bottom"),
      true
    );
    assert.equal(
      migrated.warnings.some((w) => w.code === "WARRANTY_LEGACY_BRANCHES_STRIPPED"),
      true
    );
  });
});
