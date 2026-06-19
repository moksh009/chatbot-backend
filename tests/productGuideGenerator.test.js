"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  groupShopifyProducts,
  normalizeLibrary,
  countGuideReadyProducts,
} = require("../utils/commerce/productGuideGenerator");
const {
  formatGuideMessage,
  categoriesWithGuides,
  hasInstallGuideLibrary,
} = require("../utils/commerce/installGuideFlow");

describe("productGuideGenerator", () => {
  it("groups Shopify products by first collection title", () => {
    const cats = groupShopifyProducts([
      {
        shopifyProductId: "111",
        title: "Smart Bulb",
        collectionTitles: ["Smart Home"],
        productType: "Lighting",
      },
      {
        shopifyProductId: "222",
        title: "Door Cam",
        collectionTitles: ["Cameras"],
        productType: "Security",
      },
      {
        shopifyProductId: "333",
        title: "Bulb Pro",
        collectionTitles: ["Smart Home"],
      },
    ]);
    assert.equal(cats.length, 2);
    const smart = cats.find((c) => c.label === "Smart Home");
    assert.ok(smart);
    assert.equal(smart.products.length, 2);
    assert.equal(smart.source, "shopify_collection");
  });

  it("falls back to productType then General", () => {
    const cats = groupShopifyProducts([
      { shopifyProductId: "1", title: "Widget", productType: "Gadgets", collectionTitles: [] },
      { shopifyProductId: "2", title: "Mystery", collectionTitles: [], productType: "" },
    ]);
    assert.equal(cats.length, 2);
    assert.ok(cats.find((c) => c.label === "Gadgets"));
    assert.ok(cats.find((c) => c.label === "General"));
  });

  it("counts guide-ready products", () => {
    const lib = normalizeLibrary({
      categories: [
        {
          id: "a",
          label: "A",
          products: [
            { productId: "1", title: "X", installGuide: { summary: "Hi" } },
            { productId: "2", title: "Y", installGuide: {} },
          ],
        },
      ],
    });
    assert.equal(countGuideReadyProducts(lib), 1);
  });
});

describe("installGuideFlow helpers", () => {
  it("formats guide message with steps and video", () => {
    const text = formatGuideMessage({
      title: "Apex Light",
      installGuide: {
        summary: "Quick mount guide.",
        steps: ["Mount bracket", "Connect power"],
        videoUrl: "https://youtu.be/demo",
      },
    });
    assert.match(text, /Apex Light/);
    assert.match(text, /1\. Mount bracket/);
    assert.match(text, /youtu\.be\/demo/);
  });

  it("detects library with at least one ready guide", () => {
    const client = {
      productGuideLibrary: {
        categories: [
          {
            id: "c",
            label: "C",
            products: [{ productId: "p", title: "P", installGuide: { steps: ["A"] } }],
          },
        ],
      },
    };
    assert.equal(hasInstallGuideLibrary(client), true);
    assert.equal(categoriesWithGuides(client.productGuideLibrary).length, 1);
  });
});
