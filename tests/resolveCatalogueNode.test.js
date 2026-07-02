"use strict";

const assert = require("assert");
const {
  resolveCatalogueNode,
  isUnifiedCatalogueNode,
  parseProductIds,
  MAX_PRODUCTS,
} = require("../utils/commerce/resolveCatalogueNode");

// Mock ShopifyProduct for unit tests
const originalFind = require("../models/ShopifyProduct").find;
const originalCount = require("../models/ShopifyProduct").countDocuments;

let mockFindResult = [];
let mockCountResult = 0;

function mockShopifyProduct() {
  const ShopifyProduct = require("../models/ShopifyProduct");
  ShopifyProduct.find = () => ({
    select: () => ({
      sort: () => ({
        limit: () => ({
          lean: async () => mockFindResult,
        }),
      }),
    }),
  });
  ShopifyProduct.countDocuments = async () => mockCountResult;
}

function restoreShopifyProduct() {
  const ShopifyProduct = require("../models/ShopifyProduct");
  ShopifyProduct.find = originalFind;
  ShopifyProduct.countDocuments = originalCount;
}

async function run() {
  assert.equal(parseProductIds("a, b ,c").join(","), "a,b,c");
  assert.equal(isUnifiedCatalogueNode({ catalogueMode: "product" }), true);
  assert.equal(isUnifiedCatalogueNode({ catalogueMode: "collection" }), true);
  assert.equal(isUnifiedCatalogueNode({ catalogType: "multi" }), false);

  mockShopifyProduct();

  // No catalog linked
  let r = await resolveCatalogueNode("c1", {}, { catalogueMode: "product", productIds: "v1" });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "no_catalog");

  const client = { waCatalogId: "cat_123" };

  // Collection mode — no collectionId
  r = await resolveCatalogueNode("c1", client, { catalogueMode: "collection" });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "no_products");

  // Collection mode — empty collection
  mockFindResult = [];
  r = await resolveCatalogueNode("c1", client, {
    catalogueMode: "collection",
    collectionId: "col_1",
    sectionTitle: "Hydrogen",
  });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "no_products");

  // Collection mode — success
  mockFindResult = [
    { shopifyVariantId: "v1", title: "Product A", price: 100 },
    { shopifyVariantId: "v2", title: "Product B", price: 200 },
  ];
  r = await resolveCatalogueNode("c1", client, {
    catalogueMode: "collection",
    collectionId: "col_1",
    sectionTitle: "Hydrogen",
    body: "Thanks",
  });
  assert.equal(r.ready, true);
  assert.equal(r.sections[0].title, "Hydrogen");
  assert.equal(r.sections[0].product_items.length, 2);
  assert.equal(r.productPreview.length, 2);

  // Product mode — no ids
  r = await resolveCatalogueNode("c1", client, { catalogueMode: "product" });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "no_products");

  // Product mode — stale ids (1 of 4 valid = ratio 0.25)
  mockFindResult = [{ shopifyVariantId: "v1", title: "A" }];
  const ShopifyProduct = require("../models/ShopifyProduct");
  ShopifyProduct.find = (q) => {
    if (q.shopifyVariantId) {
      return {
        select: () => ({
          lean: async () =>
            mockFindResult.filter((p) => q.shopifyVariantId.$in.includes(p.shopifyVariantId)),
        }),
      };
    }
    return originalFind(q);
  };

  r = await resolveCatalogueNode("c1", client, {
    catalogueMode: "product",
    productIds: "v1,stale2,stale3,stale4",
  });
  assert.equal(r.ready, false);
  assert.equal(r.reason, "stale_ids");

  // Product mode — success
  mockFindResult = [
    { shopifyVariantId: "v10", title: "X", price: 50 },
    { shopifyVariantId: "v20", title: "Y", price: 60 },
  ];
  ShopifyProduct.find = (q) => {
    if (q.shopifyVariantId) {
      return {
        select: () => ({
          lean: async () =>
            mockFindResult.filter((p) => q.shopifyVariantId.$in.includes(p.shopifyVariantId)),
        }),
      };
    }
    return originalFind(q);
  };

  r = await resolveCatalogueNode("c1", client, {
    catalogueMode: "product",
    productIds: "v10,v20",
    sectionTitle: "Picks",
  });
  assert.equal(r.ready, true);
  assert.equal(r.sections[0].product_items.length, 2);

  // 30 cap
  const many = Array.from({ length: 40 }, (_, i) => ({
    shopifyVariantId: `v${i}`,
    title: `P${i}`,
  }));
  mockFindResult = many;
  ShopifyProduct.find = (q) => {
    if (q.collectionIds) {
      return {
        select: () => ({
          sort: () => ({
            limit: (n) => ({
              lean: async () => many.slice(0, n),
            }),
          }),
        }),
      };
    }
    return originalFind(q);
  };
  r = await resolveCatalogueNode("c1", client, {
    catalogueMode: "collection",
    collectionId: "col_big",
  });
  assert.equal(r.sections[0].product_items.length, MAX_PRODUCTS);

  restoreShopifyProduct();
  console.log("resolveCatalogueNode.test.js: all passed");
}

run().catch((err) => {
  restoreShopifyProduct();
  console.error(err);
  process.exit(1);
});
