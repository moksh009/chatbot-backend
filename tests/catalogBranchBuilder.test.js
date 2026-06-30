"use strict";

const assert = require("assert");
const {
  buildInsertableCatalogBranch,
  getMenuVisibleCollections,
} = require("../utils/flow/catalogBranchBuilder");
const { splitCollectionsForWhatsAppMenu } = require("../utils/commerce/catalogMenuBuilder");

function makeProducts(n, collectionId) {
  return Array.from({ length: n }, (_, i) => ({
    shopifyVariantId: String(10000 + i),
    title: `Product ${i + 1}`,
    inStock: true,
    collectionIds: collectionId ? [String(collectionId)] : [],
    category: `Type${i % 3}`,
    productType: `Type${i % 3}`,
  }));
}

function makeCollections(n) {
  return Array.from({ length: n }, (_, i) => ({
    shopifyCollectionId: String(2000 + i),
    title: i === 0 ? "Best Sellers" : `Collection ${i + 1}`,
    productsCount: n - i,
    whatsappEnabled: true,
  }));
}

function assertBrowseCatalogNode(node) {
  assert.equal(node.data.catalogType, "multi", `node ${node.id} should be multi`);
  assert.equal(node.data.browseBranch, true);
  assert.ok(!node.data.metaTemplateName, `node ${node.id} should not have metaTemplateName`);
  assert.ok(!node.data.templateName, `node ${node.id} should not have templateName`);
}

function run() {
  const ctx5 = {
    products: makeProducts(20, "2000").concat(makeProducts(5, "2001")),
    mpmTemplateName: "carosuel",
    useCollections: true,
    menuSplit: splitCollectionsForWhatsAppMenu(makeCollections(5)),
    buckets: [],
    catalogLinked: true,
  };
  const g5 = buildInsertableCatalogBranch(ctx5, { seed: 1, nextNodeOrder: 1 });
  assert.equal(g5.nodes.filter((n) => n.type === "catalog").length, 5);
  assert.ok(g5.entryNodeId);
  g5.nodes.filter((n) => n.type === "catalog").forEach(assertBrowseCatalogNode);
  assert.ok(g5.nodes.some((n) => n.type === "catalog" && n.data.productIds.includes("10000")));

  const split15 = splitCollectionsForWhatsAppMenu(makeCollections(15));
  const products15 = [];
  for (let i = 0; i < 15; i++) {
    products15.push(...makeProducts(3, String(2000 + i)));
  }
  const ctx15 = {
    products: products15,
    mpmTemplateName: "carosuel",
    useCollections: true,
    menuSplit: split15,
    buckets: [],
    catalogLinked: true,
  };
  const g15 = buildInsertableCatalogBranch(ctx15, { seed: 2, nextNodeOrder: 1 });
  assert.equal(g15.nodes.filter((n) => n.type === "catalog").length, 15);
  assert.ok(g15.overflowNodeId);
  assert.ok(g15.edges.some((e) => e.sourceHandle === "menu"), "main menu edge should exist");

  const split25 = splitCollectionsForWhatsAppMenu(makeCollections(25));
  const visible25 = getMenuVisibleCollections(split25);
  const products25 = [];
  for (let i = 0; i < 25; i++) {
    products25.push(...makeProducts(2, String(2000 + i)));
  }
  const ctx25 = {
    products: products25,
    mpmTemplateName: "carosuel",
    useCollections: true,
    menuSplit: split25,
    buckets: [],
    catalogLinked: true,
  };
  const g25 = buildInsertableCatalogBranch(ctx25, { seed: 4, nextNodeOrder: 1 });
  assert.equal(visible25.length, 19, "menu shows max 19 collections");
  assert.equal(g25.nodes.filter((n) => n.type === "catalog").length, 19);

  const prods = makeProducts(12);
  const buckets = new Map();
  prods.forEach((p) => {
    const k = p.productType;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  });
  const ctxBucket = {
    products: prods,
    mpmTemplateName: "carosuel",
    useCollections: false,
    menuSplit: null,
    buckets: Array.from(buckets.entries()),
    catalogLinked: false,
  };
  const gBucket = buildInsertableCatalogBranch(ctxBucket, { seed: 3, nextNodeOrder: 1 });
  assert.ok(gBucket.nodes.filter((n) => n.type === "catalog").length >= 1);
  assert.ok(gBucket.nodes.some((n) => n.type === "message" && String(n.id).includes("no_catalog")));
  gBucket.nodes.filter((n) => n.type === "catalog").forEach(assertBrowseCatalogNode);

  console.log("catalogBranchBuilder tests passed");
}

run();
