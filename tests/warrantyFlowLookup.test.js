"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyWarrantyScenario,
  formatWarrantyStatusDisplay,
} = require("../utils/commerce/warrantyCustomerProfileService");
const {
  findWarrantyOutputEdge,
  buildDetailsBody,
  buildScenarioOneBody,
  buildScenarioFiveBody,
  buildListRows,
  buildSimulatorWarrantyPreview,
  isMenuSelection,
  isListMoreSelection,
  MENU_BUTTON_ID,
  LIST_MORE_ID,
} = require("../utils/commerce/warrantyFlowLookup");

describe("warrantyCustomerProfileService", () => {
  it("classifies scenario 5 — no orders and no warranty", () => {
    assert.equal(
      classifyWarrantyScenario({ orderCount: 0, ordersWithWarranty: [] }),
      "no_customer"
    );
  });

  it("classifies scenario 5 — contact only without orders or warranty", () => {
    assert.equal(
      classifyWarrantyScenario({
        orderCount: 0,
        ordersWithWarranty: [],
        hasContact: true,
      }),
      "no_customer"
    );
  });

  it("classifies scenario 1 — orders but no warranty line items", () => {
    assert.equal(
      classifyWarrantyScenario({ orderCount: 2, ordersWithWarranty: [] }),
      "orders_no_warranty"
    );
  });

  it("classifies scenario 2 — single order, single item", () => {
    assert.equal(
      classifyWarrantyScenario({
        orderCount: 1,
        ordersWithWarranty: [{ orderKey: "1035", items: [{ productName: "A" }] }],
      }),
      "single_order_single_item"
    );
  });

  it("classifies scenario 3 — single order, multiple items", () => {
    assert.equal(
      classifyWarrantyScenario({
        orderCount: 1,
        ordersWithWarranty: [
          { orderKey: "1035", items: [{ productName: "A" }, { productName: "B" }] },
        ],
      }),
      "single_order_multi_item"
    );
  });

  it("classifies scenario 4 — multiple orders with warranty", () => {
    assert.equal(
      classifyWarrantyScenario({
        orderCount: 3,
        ordersWithWarranty: [
          { orderKey: "1", items: [{ productName: "A" }] },
          { orderKey: "2", items: [{ productName: "B" }] },
        ],
      }),
      "multi_order"
    );
  });

  it("formats warranty status labels for WhatsApp copy", () => {
    assert.equal(formatWarrantyStatusDisplay("active"), "Active");
    assert.equal(formatWarrantyStatusDisplay("void"), "Void/Refunded");
    assert.equal(formatWarrantyStatusDisplay("terminated"), "Terminated");
  });
});

describe("warrantyFlowLookup", () => {
  it("uses exact scenario 1 copy", () => {
    const body = buildScenarioOneBody("+91 9876543210");
    assert.match(body, /Registered Number for Warranty Check/);
    assert.match(body, /Amongst your all orders/);
    assert.match(body, /Please click 'Menu'/);
  });

  it("uses exact scenario 5 copy", () => {
    const body = buildScenarioFiveBody("+91 9876543210");
    assert.match(body, /Phone number checked/);
    assert.match(body, /Tap 'Menu'/);
  });

  it("buildDetailsBody lists every item with status and duration", () => {
    const body = buildDetailsBody("+91 9876543210", {
      orderDisplay: "#1035",
      items: [
        { productName: "Shirt", status: "Active", duration: "1 Year" },
        { productName: "Pants", status: "Expired", duration: "12 months" },
      ],
    });
    assert.match(body, /#1035/);
    assert.match(body, /Shirt/);
    assert.match(body, /Pants/);
    assert.match(body, /🛡️ Status:/);
    assert.match(body, /Tap 'Menu'/);
  });

  it("prefers bottom/output edge only (not legacy branches)", () => {
    const edges = [
      { id: "e1", source: "w1", sourceHandle: "active", target: "a" },
      { id: "e2", source: "w1", sourceHandle: "bottom", target: "menu" },
    ];
    assert.equal(findWarrantyOutputEdge(edges, "w1")?.target, "menu");
    assert.equal(findWarrantyOutputEdge([edges[0]], "w1"), null);
  });

  it("buildListRows paginates with More orders and Menu", () => {
    const orders = Array.from({ length: 12 }, (_, i) => ({
      orderKey: String(1000 + i),
      orderDisplay: `#${1000 + i}`,
    }));
    const page0 = buildListRows(orders, 0);
    assert.equal(page0.some((r) => r.id === LIST_MORE_ID), true);
    assert.equal(page0[page0.length - 1].title, "Menu");
    assert.equal(
      page0.every((r) => r.description === undefined),
      true
    );
    const page1 = buildListRows(orders, 1);
    assert.equal(page1.some((r) => r.id === LIST_MORE_ID), false);
    assert.equal(page1[page1.length - 1].title, "Menu");
  });

  it("detects Menu and More orders selections", () => {
    assert.equal(isMenuSelection({ buttonId: MENU_BUTTON_ID }), true);
    assert.equal(isMenuSelection({ buttonTitle: "Menu" }), true);
    assert.equal(isListMoreSelection({ buttonId: LIST_MORE_ID }), true);
  });
});

describe("buildSimulatorWarrantyPreview", () => {
  const phone = "+919876543210";

  it("preview for no_customer (scenario 4/5 — profile missing)", () => {
    const body = buildSimulatorWarrantyPreview({ displayPhone: phone }, "no_customer");
    assert.match(body, /Phone number checked/);
    assert.match(body, /Menu/);
  });

  it("preview for orders_no_warranty (scenario 3)", () => {
    const body = buildSimulatorWarrantyPreview(
      { displayPhone: phone, ordersWithWarranty: [] },
      "orders_no_warranty"
    );
    assert.match(body, /Registered Number for Warranty Check/);
  });

  it("preview for multi_order (scenario 2)", () => {
    const profile = {
      displayPhone: phone,
      ordersWithWarranty: [
        { orderDisplay: "#1001", items: [{ productName: "A", status: "Active", duration: "1 Year" }] },
        { orderDisplay: "#1002", items: [{ productName: "B", status: "Active", duration: "1 Year" }] },
      ],
    };
    const body = buildSimulatorWarrantyPreview(profile, "multi_order");
    assert.match(body, /Multiple orders/);
    assert.match(body, /#1001/);
    assert.match(body, /interactive list/i);
  });

  it("preview for single active warranty (scenario 1)", () => {
    const profile = {
      displayPhone: phone,
      ordersWithWarranty: [
        {
          orderDisplay: "#1042",
          items: [{ productName: "Shirt", status: "Active", duration: "1 Year" }],
        },
      ],
    };
    const body = buildSimulatorWarrantyPreview(profile, "single_order_single_item");
    assert.match(body, /#1042/);
    assert.match(body, /Shirt/);
    assert.match(body, /Status:/);
  });
});
